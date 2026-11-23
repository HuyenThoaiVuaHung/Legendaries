import type { CountdownStatus, CountdownView, TimerId } from '../contracts/game';
import type { ServerTime } from './server-time';

export type DecisionOwner = 'admin' | 'player';

export interface StartOptions {
  /** Wait this long before the run begins (status 'pending'). */
  delayMs?: number;
  owner?: DecisionOwner;
}

export interface CountdownHandlers {
  /** Called after every transition with the new view. */
  onChange?: (view: CountdownView) => void;
  /** Called after the 'expired' change, with the run's owner. */
  onExpire?: (owner: DecisionOwner | undefined) => void;
}

/**
 * Deadline-based countdown. State is a deadline on the monotonic clock; there
 * is exactly one scheduled callback per run (start, then expiry) and no tick.
 */
export class Countdown {
  private state: CountdownStatus = 'idle';
  private seqNo = 0;
  private duration = 0;
  private startMono: number | null = null;
  private deadline: number | null = null;
  private frozenMs = 0;
  private runOwner: DecisionOwner | undefined;
  private generation = 0;
  private cancelScheduled?: () => void;

  constructor(
    readonly id: TimerId,
    private readonly time: ServerTime,
    private readonly handlers: CountdownHandlers = {},
  ) {}

  get status(): CountdownStatus {
    return this.state;
  }

  get seq(): number {
    return this.seqNo;
  }

  get durationMs(): number {
    return this.duration;
  }

  get owner(): DecisionOwner | undefined {
    return this.runOwner;
  }

  /** Monotonic instant the current run begins counting, if any. */
  get startsAtMono(): number | null {
    return this.startMono;
  }

  /** Monotonic instant of expiry (kept after expiry for grace checks). */
  get deadlineMono(): number | null {
    return this.deadline;
  }

  /** Begin a run, superseding any run in progress without emitting an end. */
  start(durationMs: number, options: StartOptions = {}): void {
    this.cancel();
    const generation = ++this.generation;
    const delayMs = Math.max(0, options.delayMs ?? 0);
    this.duration = durationMs;
    this.runOwner = options.owner;
    this.startMono = this.time.mono() + delayMs;
    this.deadline = this.startMono + durationMs;
    this.frozenMs = 0;
    if (delayMs > 0) {
      this.state = 'pending';
      this.cancelScheduled = this.time.schedule(this.startMono, () => this.begin(generation));
    } else {
      this.state = 'running';
      this.cancelScheduled = this.time.schedule(this.deadline, () => this.expire(generation));
    }
    this.changed();
  }

  /** Freeze the remainder. Returns false when not pending/running. */
  pause(): boolean {
    if (this.state !== 'running' && this.state !== 'pending') return false;
    this.frozenMs = this.remainingMs();
    this.cancel();
    this.generation++;
    this.state = 'paused';
    this.changed();
    return true;
  }

  /** Continue from the frozen remainder. Returns false when not paused. */
  resume(): boolean {
    if (this.state !== 'paused') return false;
    const generation = ++this.generation;
    const now = this.time.mono();
    this.startMono = now;
    this.deadline = now + this.frozenMs;
    this.state = 'running';
    this.cancelScheduled = this.time.schedule(this.deadline, () => this.expire(generation));
    this.changed();
    return true;
  }

  /** Restore a paused run (used after a server restart). */
  restorePaused(durationMs: number, remainingMs: number): void {
    this.cancel();
    this.generation++;
    this.duration = durationMs;
    this.frozenMs = remainingMs;
    this.startMono = null;
    this.deadline = null;
    this.runOwner = undefined;
    this.state = 'paused';
    this.changed();
  }

  /** End a live run early. Returns false when there was nothing to stop. */
  stop(): boolean {
    if (!this.isLive() && this.state !== 'paused') return false;
    this.cancel();
    this.generation++;
    this.state = 'stopped';
    this.frozenMs = 0;
    this.changed();
    return true;
  }

  /** Cancel everything silently (room teardown). */
  dispose(): void {
    this.cancel();
    this.generation++;
  }

  remainingMs(at: number = this.time.mono()): number {
    switch (this.state) {
      case 'running':
        return Math.max(0, (this.deadline ?? at) - at);
      case 'pending':
        return this.duration;
      case 'paused':
        return this.frozenMs;
      default:
        return 0;
    }
  }

  /**
   * Active time spent in the run at `at`: pauses excluded, and past the
   * deadline it keeps growing so grace-window arrivals rank after the expiry.
   */
  activeElapsedMs(at: number = this.time.mono()): number {
    if (this.state === 'expired' && this.deadline !== null) return this.duration + Math.max(0, at - this.deadline);
    return Math.max(0, this.duration - this.remainingMs(at));
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  /** Pending or running: the clock owns the round. */
  isLive(): boolean {
    return this.state === 'pending' || this.state === 'running';
  }

  isPaused(): boolean {
    return this.state === 'paused';
  }

  /** True when an answer arriving at `arrivalMono` still counts. */
  acceptsAt(arrivalMono: number, graceMs: number): boolean {
    if (this.state === 'running') return true;
    return this.state === 'expired' && this.deadline !== null && arrivalMono <= this.deadline + graceMs;
  }

  view(): CountdownView {
    const live = this.isLive();
    return {
      id: this.id,
      status: this.state,
      durationMs: this.duration,
      remainingMs: Math.round(this.remainingMs()),
      startsAt: live && this.startMono !== null ? this.time.epoch(this.startMono) : null,
      deadline: live && this.deadline !== null ? this.time.epoch(this.deadline) : null,
      serverTime: this.time.epoch(),
      seq: this.seqNo,
      ...(this.runOwner && this.state !== 'idle' ? { owner: this.runOwner } : {}),
    };
  }

  private begin(generation: number): void {
    if (generation !== this.generation || this.state !== 'pending' || this.deadline === null) return;
    this.state = 'running';
    this.cancelScheduled = this.time.schedule(this.deadline, () => this.expire(generation));
    this.changed();
  }

  private expire(generation: number): void {
    if (generation !== this.generation || this.state !== 'running') return;
    this.cancelScheduled = undefined;
    this.state = 'expired';
    this.frozenMs = 0;
    this.changed();
    this.handlers.onExpire?.(this.runOwner);
  }

  private cancel(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
  }

  private changed(): void {
    this.seqNo++;
    this.handlers.onChange?.(this.view());
  }
}
