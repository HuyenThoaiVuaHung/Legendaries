import type { CountdownView, MatchPosition, TimerId } from '../contracts/game';
import type { GameRules } from '../game.rules';
import type { RoomChannel } from '../rooms/room';
import type { GameSessionState } from '../state/game.state';
import type { MatchStore } from '../state/match.store';
import {
  clockRoundOf,
  onKdDecisionExpired,
  onKdDecisionStopped,
  onMainEnded,
  onVdStealClosed,
  PolicyEnv,
  sfxFor,
  startDelayMs,
} from './clock.policies';
import { Countdown, DecisionOwner } from './countdown';
import type { ServerTime } from './server-time';

const MS_PER_SECOND = 1000;
const DECISION_STEP_MS = 100;
/** A client relay of a timed SFX the server just auto-played is ignored within this window. */
const SFX_DEDUPE_MS = 1500;

/**
 * Old per-tick events, emitted from the new countdowns with the old value
 * semantics. Only schedules while a countdown runs. Delete this class and its
 * two call sites in RoomTimers to drop the legacy protocol.
 */
export class LegacyClockBridge {
  private readonly cancels = new Map<TimerId, () => void>();

  constructor(
    private readonly channel: RoomChannel,
    private readonly time: ServerTime,
  ) {}

  onChange(view: CountdownView, countdown: Countdown): void {
    this.cancels.get(view.id)?.();
    this.cancels.delete(view.id);
    const live = view.status === 'running';
    const ended = view.status === 'expired' || view.status === 'stopped';
    switch (view.id) {
      case 'main':
        if (live) this.tick(countdown, MS_PER_SECOND, (n) => this.channel.emit('update-clock', n));
        else if (view.status === 'paused') this.channel.emit('update-clock', Math.ceil(view.remainingMs / MS_PER_SECOND));
        else if (ended) this.channel.emit('update-clock', 0);
        break;
      case 'kdDecision': {
        const isPlayer = view.owner === 'player';
        if (live) this.tick(countdown, DECISION_STEP_MS, (n) => this.channel.emit('update-3s-timer-kd', n, isPlayer));
        else if (ended) {
          if (isPlayer && view.status === 'stopped') this.channel.emit('update-3s-timer-kd', 0, true);
          this.channel.emit('update-3s-timer-kd', 0, view.status === 'stopped' ? false : isPlayer);
        }
        break;
      }
      case 'vdSteal':
        if (live) this.tick(countdown, DECISION_STEP_MS, (n) => this.channel.emit('update-5s-countdown-vd', n));
        else if (ended) this.channel.emit('update-5s-countdown-vd', 0);
        break;
    }
  }

  dispose(): void {
    for (const cancel of this.cancels.values()) cancel();
    this.cancels.clear();
  }

  /** Emit the current step count now, then again at each boundary until expiry. */
  private tick(countdown: Countdown, stepMs: number, emit: (steps: number) => void, at = this.time.mono()): void {
    const steps = Math.ceil(countdown.remainingMs(at) / stepMs);
    emit(steps);
    const deadline = countdown.deadlineMono;
    if (steps <= 1 || deadline === null) return;
    const next = deadline - (steps - 1) * stepMs;
    this.cancels.set(
      countdown.id,
      this.time.schedule(next, () => this.tick(countdown, stepMs, emit, Math.max(this.time.mono(), next))),
    );
  }
}

/** Every countdown a room owns, plus the 'clock-state' broadcast. */
export class RoomTimers {
  readonly main: Countdown;
  readonly kdDecision: Countdown;
  readonly vdSteal: Countdown;
  private readonly bridge: LegacyClockBridge;
  private readonly env: PolicyEnv;
  /** Multiplayer KD flow claims a decision expiry by returning true; otherwise the legacy policy runs. */
  kdExpiryHandler: ((owner: DecisionOwner | undefined) => boolean) | null = null;
  private cancelSfx?: () => void;
  private autoSfx: { code: string; atMono: number } | null = null;
  private clientSfx: { code: string; atMono: number } | null = null;

  constructor(
    private readonly channel: RoomChannel,
    private readonly store: MatchStore,
    session: GameSessionState,
    private readonly rules: GameRules,
    readonly time: ServerTime,
  ) {
    this.bridge = new LegacyClockBridge(channel, time);
    this.env = { channel, session, store, mainHasTime: () => (this.main.isRunning() || this.main.isPaused()) && this.main.remainingMs() > 0 };
    this.main = new Countdown('main', time, { onChange: (view) => this.onMainChange(view) });
    this.kdDecision = new Countdown('kdDecision', time, {
      onChange: (view) => this.onDecisionChange(view, this.kdDecision),
      onExpire: (owner) => {
        if (!this.kdExpiryHandler?.(owner)) onKdDecisionExpired(this.env, owner);
      },
    });
    this.vdSteal = new Countdown('vdSteal', time, {
      onChange: (view) => this.onDecisionChange(view, this.vdSteal),
      onExpire: () => onVdStealClosed(this.env),
    });
  }

  /** After a restart a clock that was running comes back paused at its remainder. */
  restorePaused(): void {
    const seconds = this.store.getMatch().pausedTimerSeconds;
    if (seconds > 0) this.main.restorePaused(seconds * MS_PER_SECOND, seconds * MS_PER_SECOND);
  }

  /** Start the main clock; returns the monotonic instant it begins counting. */
  startMain(seconds: number, delayMs: number): number {
    this.cancelSfx?.();
    this.cancelSfx = undefined;
    this.main.start(seconds * MS_PER_SECOND, { delayMs });
    return this.main.startsAtMono ?? this.time.mono();
  }

  /** Pause when live, resume when paused (the old playPauseTime). */
  togglePause(): void {
    if (this.main.isPaused()) this.main.resume();
    else this.main.pause();
  }

  startDelayFor(position: MatchPosition): number {
    return startDelayMs(this.rules, clockRoundOf(position));
  }

  startKdDecision(isPlayerTimer: boolean): void {
    this.kdDecision.start(this.rules.kdDecisionMs, { owner: isPlayerTimer ? 'player' : 'admin' });
  }

  stopKdDecision(): void {
    const owner: DecisionOwner | undefined = this.kdDecision.owner;
    if (this.kdDecision.stop()) onKdDecisionStopped(this.env, owner);
  }

  startVdSteal(): void {
    this.vdSteal.start(this.rules.vdStealMs);
  }

  stopVdSteal(): void {
    if (this.vdSteal.stop()) onVdStealClosed(this.env);
  }

  /** Auto-play a timed SFX at a monotonic instant (now when already due). */
  playSfxAt(code: string, atMono: number): void {
    this.autoSfx = { code, atMono };
    const now = this.time.mono();
    if (this.clientSfx?.code === code && now - this.clientSfx.atMono <= SFX_DEDUPE_MS) return;
    if (atMono <= now) this.channel.emit('play-sfx', code);
    else this.cancelSfx = this.time.schedule(atMono, () => this.channel.emit('play-sfx', code));
  }

  /** True when a client relay of `code` duplicates the server's own play. */
  isDuplicateClientSfx(code: string): boolean {
    const now = this.time.mono();
    if (this.autoSfx?.code === code && now <= this.autoSfx.atMono + SFX_DEDUPE_MS) return true;
    this.clientSfx = { code, atMono: now };
    return false;
  }

  sfxCodeFor(position: MatchPosition, seconds: number): string | null {
    return sfxFor(clockRoundOf(position), seconds);
  }

  snapshot(): Record<TimerId, CountdownView> {
    return { main: this.main.view(), kdDecision: this.kdDecision.view(), vdSteal: this.vdSteal.view() };
  }

  dispose(): void {
    this.cancelSfx?.();
    this.cancelSfx = undefined;
    this.main.dispose();
    this.kdDecision.dispose();
    this.vdSteal.dispose();
    this.bridge.dispose();
  }

  private onMainChange(view: CountdownView): void {
    this.persistPaused(view);
    this.channel.emit('clock-state', view);
    this.bridge.onChange(view, this.main);
    if (view.status === 'paused' || view.status === 'expired' || view.status === 'stopped') {
      onMainEnded(this.env, clockRoundOf(this.store.getMatch().position));
    }
  }

  private onDecisionChange(view: CountdownView, countdown: Countdown): void {
    this.channel.emit('clock-state', view);
    this.bridge.onChange(view, countdown);
  }

  /** The persisted carrier: ceil seconds while paused, 0 otherwise. */
  private persistPaused(view: CountdownView): void {
    const seconds = view.status === 'paused' ? Math.ceil(view.remainingMs / MS_PER_SECOND) : 0;
    if (this.store.getMatch().pausedTimerSeconds === seconds) return;
    this.store.updateMatch((match) => {
      match.pausedTimerSeconds = seconds;
    });
  }
}
