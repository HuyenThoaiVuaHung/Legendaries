import type {
  KdFlowState,
  KdMarkCommand,
  KdMarkRejectReason,
  KdPhase,
  KdResolved,
  KdVerdict,
} from '../contracts/game';
import type { GameRules } from '../game.rules';
import type { RoomChannel } from '../rooms/room';
import { GameSessionState, NO_PLAYER } from '../state/game.state';
import type { MatchStore } from '../state/match.store';
import type { DecisionOwner } from '../time/countdown';
import type { RoomTimers } from '../time/room-timers';
import type { ServerTime } from '../time/server-time';

// Sound-effect identifiers understood by the frontend (protocol vocabulary).
// There is no time-up asset, so manual mode stays silent.
const SFX_GET_TURN = 'KD_GET_TURN';
const SFX_WRONG = 'KD_WRONG';

/**
 * Server-owned state machine of one multiplayer KD question: reading, buzz
 * window, answering, grading. Single-player KD never touches it.
 * The buzzer opens only after a question's arm delay; marks never reopen it.
 */
export class KdFlow {
  private phase: KdPhase = 'idle';
  private seq = 0;
  private lastMark: KdResolved | null = null;
  /** The mark just undone; one re-grade of it is accepted. */
  private undone: KdResolved | null = null;
  private cancelArm?: () => void;
  private cancelClose?: () => void;

  constructor(
    private readonly channel: RoomChannel,
    private readonly store: MatchStore,
    private readonly session: GameSessionState,
    private readonly timers: RoomTimers,
    private readonly rules: GameRules,
    private readonly time: ServerTime,
  ) {
    timers.kdExpiryHandler = (owner) => this.onDecisionExpired(owner);
  }

  get questionSeq(): number {
    return this.seq;
  }

  get currentPhase(): KdPhase {
    return this.phase;
  }

  isMultiplayer(): boolean {
    return this.store.round('kd').get().gamemode === 'M';
  }

  state(): KdFlowState {
    return {
      phase: this.phase,
      questionSeq: this.seq,
      turnPlayerIndex: this.session.kdTurnPlayerIndex,
      lastMark: this.lastMark,
      timeUpMode: this.rules.kdTimeUpMode,
    };
  }

  /** A new question went out: lock, then open the buzz window after the arm delay. */
  beginQuestion(): void {
    this.cancelPending();
    this.timers.kdDecision.stop();
    this.seq += 1;
    this.lockBuzzer();
    this.clearTurn();
    this.setPhase('reading');
    const seq = this.seq;
    if (this.rules.kdBuzzArmDelayMs <= 0) this.openWindow(seq);
    else this.cancelArm = this.time.schedule(this.time.mono() + this.rules.kdBuzzArmDelayMs, () => this.openWindow(seq));
  }

  /** Question removed or round restarted: back to idle with the buzzer locked. */
  reset(): void {
    this.cancelPending();
    this.timers.kdDecision.stop();
    this.lockBuzzer();
    this.clearTurn();
    this.setPhase('idle');
  }

  /** First valid press wins. Returns true when it took the turn. */
  buzz(playerIndex: number): boolean {
    const arrival = this.time.mono();
    const window = this.timers.kdDecision;
    const inWindow = this.phase === 'buzzWindow' && window.owner === 'admin' && window.acceptsAt(arrival, this.rules.submissionGraceMs);
    if (!inWindow || !this.session.kdBuzzerOpen || this.session.kdTurnPlayerIndex !== NO_PLAYER) return false;
    this.cancelClose?.();
    this.cancelClose = undefined;
    this.session.kdTurnPlayerIndex = playerIndex;
    this.session.kdBuzzerOpen = false;
    this.channel.emit('play-sfx', SFX_GET_TURN);
    this.channel.emit('disable-answer-button-kd');
    this.channel.emit('player-got-turn-kd', playerIndex);
    this.startAnswer();
    return true;
  }

  /** Admin "reset turn": a fresh buzz window for the same question. */
  restartBuzzWindow(): void {
    if (this.phase === 'idle' || this.phase === 'reading') return;
    this.cancelPending();
    this.clearTurn();
    this.openWindow(this.seq);
  }

  /** Legacy "start player timer": resume answering for the current holder. */
  resumeAnswer(): void {
    if (this.phase !== 'awaitingMark' || this.session.kdTurnPlayerIndex === NO_PLAYER) return;
    this.startAnswer();
  }

  /** Stop the answer countdown without grading; the admin marks next. */
  freezeAnswer(): void {
    if (this.phase !== 'answering') return;
    this.timers.kdDecision.stop();
    this.setPhase('awaitingMark');
  }

  /** Grade the question. Returns a reject reason, or null when applied. */
  mark(verdict: KdVerdict, cmd: KdMarkCommand): KdMarkRejectReason | null {
    const redo = this.undone;
    if (redo && cmd.questionSeq === redo.questionSeq && cmd.playerIndex === redo.playerIndex) {
      this.undone = null;
      const delta = this.applyScore(verdict, cmd.playerIndex);
      this.lastMark = { questionSeq: redo.questionSeq, playerIndex: cmd.playerIndex, verdict, auto: false, scoreDelta: delta };
      this.channel.emit('update-match-data', this.store.getMatch());
      this.channel.emit('kd-resolved', this.lastMark);
      this.emitPhase();
      return null;
    }
    if (cmd.questionSeq !== this.seq) return 'stale-question';
    if (this.phase !== 'answering' && this.phase !== 'awaitingMark') return 'bad-phase';
    const turn = this.session.kdTurnPlayerIndex;
    if (cmd.playerIndex !== turn) return 'wrong-player';
    if (turn === NO_PLAYER && verdict !== 'noAnswer') return 'wrong-player';
    this.resolve(verdict, turn, false);
    return null;
  }

  /** Reverse the last grade's score and keep it as the one re-grade target. */
  undo(): KdMarkRejectReason | null {
    const mark = this.lastMark;
    if (!mark) return 'nothing-to-undo';
    if (mark.scoreDelta !== 0) {
      this.store.updateMatch((m) => {
        const player = m.players[mark.playerIndex];
        if (player) player.score -= mark.scoreDelta;
      });
    }
    this.channel.emit('update-match-data', this.store.getMatch());
    this.undone = mark;
    this.lastMark = null;
    this.emitPhase();
    return null;
  }

  private openWindow(seq: number): void {
    if (seq !== this.seq) return;
    this.cancelArm = undefined;
    this.session.kdBuzzerOpen = true;
    this.channel.emit('enable-answer-button-kd');
    this.timers.kdDecision.start(this.rules.kdBuzzWindowMs, { owner: 'admin' });
    this.setPhase('buzzWindow');
  }

  private startAnswer(): void {
    this.timers.kdDecision.start(this.rules.kdDecisionMs, { owner: 'player' });
    this.setPhase('answering');
  }

  /** Timer expiry; returns true when the flow owns this window. */
  private onDecisionExpired(owner: DecisionOwner | undefined): boolean {
    if (!this.isMultiplayer()) return false;
    if (owner === 'admin' && this.phase === 'buzzWindow') {
      // A press up to the grace window still counts, so the close is deferred.
      const seq = this.seq;
      const closeAt = (this.timers.kdDecision.deadlineMono ?? this.time.mono()) + this.rules.submissionGraceMs;
      if (closeAt <= this.time.mono()) this.closeWindow(seq);
      else this.cancelClose = this.time.schedule(closeAt, () => this.closeWindow(seq));
      return true;
    }
    if (owner === 'player' && this.phase === 'answering') {
      this.answerExpired();
      return true;
    }
    return false;
  }

  private closeWindow(seq: number): void {
    this.cancelClose = undefined;
    if (seq !== this.seq || this.phase !== 'buzzWindow') return;
    this.lockBuzzer();
    if (this.rules.kdTimeUpMode === 'autoWrong') this.resolve('noAnswer', NO_PLAYER, true);
    else this.setPhase('awaitingMark');
  }

  private answerExpired(): void {
    this.lockBuzzer();
    if (this.rules.kdTimeUpMode === 'autoWrong') {
      this.channel.emit('play-sfx', SFX_WRONG);
      this.resolve('wrong', this.session.kdTurnPlayerIndex, true);
    } else {
      this.setPhase('awaitingMark');
    }
  }

  private resolve(verdict: KdVerdict, playerIndex: number, auto: boolean): void {
    const { session } = this;
    this.timers.kdDecision.stop();
    this.lockBuzzer();
    const scoreDelta = this.applyScore(verdict, playerIndex);
    session.kdCurrentQuestionNo += 1;
    this.channel.emit('update-number-question-kd', session.kdMaxQuestionCount, session.kdCurrentQuestionNo);
    this.channel.emit('update-match-data', this.store.getMatch());
    this.lastMark = { questionSeq: this.seq, playerIndex, verdict, auto, scoreDelta };
    this.undone = null;
    this.clearTurn();
    this.channel.emit('kd-resolved', this.lastMark);
    this.setPhase('resolved');
  }

  /** Apply the verdict's score change; returns what was actually applied. */
  private applyScore(verdict: KdVerdict, playerIndex: number): number {
    let delta = 0;
    this.store.updateMatch((m) => {
      const player = m.players[playerIndex];
      if (!player) return;
      if (verdict === 'correct') delta = this.rules.kdCorrectPoints;
      else if (verdict === 'wrong') delta = -Math.min(this.rules.kdWrongPenalty, Math.max(0, player.score));
      player.score += delta;
    });
    return delta;
  }

  private lockBuzzer(): void {
    if (!this.session.kdBuzzerOpen) return;
    this.session.kdBuzzerOpen = false;
    this.channel.emit('disable-answer-button-kd');
  }

  private clearTurn(): void {
    if (this.session.kdTurnPlayerIndex === NO_PLAYER) return;
    this.session.kdTurnPlayerIndex = NO_PLAYER;
    this.channel.emit('clear-turn-player-kd');
  }

  private cancelPending(): void {
    this.cancelArm?.();
    this.cancelArm = undefined;
    this.cancelClose?.();
    this.cancelClose = undefined;
  }

  private setPhase(phase: KdPhase): void {
    this.phase = phase;
    this.emitPhase();
  }

  private emitPhase(): void {
    this.channel.emit('kd-phase', this.state());
  }
}
