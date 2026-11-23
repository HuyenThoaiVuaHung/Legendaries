import type { MatchPosition } from '../contracts/game';
import { CLOCK_ROUNDS, ClockRound, GameRules } from '../game.rules';
import type { RoomChannel } from '../rooms/room';
import { GameSessionState, NO_PLAYER } from '../state/game.state';
import type { MatchStore } from '../state/match.store';
import type { DecisionOwner } from './countdown';

// Sound-effect identifiers understood by the frontend (protocol vocabulary).
const SFX_WRONG = 'KD_WRONG';

/** Nominal durations for timed countdown SFX so reconnecting clients can seek and resume. */
export const TIMED_SFX_DURATIONS_MS: Readonly<Record<string, number>> = {
  KD_60S: 60_000,
  KD_90S: 90_000,
  VCNV_15S: 15_000,
  TT_10S: 10_000,
  TT_20S: 20_000,
  TT_30S: 30_000,
  TT_40S: 40_000,
  VD_5S: 5_000,
  VD_15S: 15_000,
  VD_20S: 20_000,
};

type Buzzer = 'kd' | 'chp';

interface RoundClockPolicy {
  /** Prefix of the countdown SFX the server auto-plays; null for none. */
  sfxPrefix: string | null;
  /**
   * Buzzers closed when the main clock stops, expires or pauses. Every round
   * closes both, exactly as the old server's finish() did.
   */
  lockOnEnd: readonly Buzzer[];
}

const BOTH_BUZZERS: readonly Buzzer[] = ['kd', 'chp'];

const POLICIES: Readonly<Record<ClockRound, RoundClockPolicy>> = {
  KD: { sfxPrefix: null, lockOnEnd: BOTH_BUZZERS },
  VCNV: { sfxPrefix: 'VCNV', lockOnEnd: BOTH_BUZZERS },
  TT: { sfxPrefix: 'TT', lockOnEnd: BOTH_BUZZERS },
  VD: { sfxPrefix: 'VD', lockOnEnd: BOTH_BUZZERS },
  CHP: { sfxPrefix: null, lockOnEnd: BOTH_BUZZERS },
};

/** Round whose policy applies at a match position; non-round positions use KD's. */
export function clockRoundOf(position: MatchPosition): ClockRound {
  const prefix = position.split('_')[0] as ClockRound;
  return CLOCK_ROUNDS.includes(prefix) ? prefix : 'KD';
}

export function startDelayMs(rules: GameRules, round: ClockRound): number {
  return rules.clockStartDelayMs[round];
}

/** Auto-played countdown SFX code for a clock of `seconds`, if one exists. */
export function sfxFor(round: ClockRound, seconds: number): string | null {
  const prefix = POLICIES[round].sfxPrefix;
  if (prefix === null) return null;
  const code = `${prefix}_${seconds}S`;
  return TIMED_SFX_DURATIONS_MS[code] !== undefined ? code : null;
}

/** What the policies may touch when a timer ends. */
export interface PolicyEnv {
  channel: RoomChannel;
  session: GameSessionState;
  store: MatchStore;
  /** True while the main clock still has time (running or paused). */
  mainHasTime: () => boolean;
}

/** Main clock stopped, expired or paused: lock the buzzers the round locks. */
export function onMainEnded(env: PolicyEnv, round: ClockRound): void {
  const { session, channel } = env;
  const locks = POLICIES[round].lockOnEnd;
  if (locks.includes('kd')) session.kdBuzzerOpen = false;
  if (locks.includes('chp')) session.chpBuzzerOpen = false;
  if (locks.includes('chp')) channel.emit('lock-button-chp');
  if (locks.includes('kd')) channel.emit('disable-answer-button-kd');
}

function reopenKdBuzzer(env: PolicyEnv): void {
  if (!env.mainHasTime()) return;
  env.session.kdBuzzerOpen = true;
  env.channel.emit('enable-answer-button-kd');
}

function emitQuestionNumbers(env: PolicyEnv): void {
  const { session } = env;
  env.channel.emit('update-number-question-kd', session.kdMaxQuestionCount, session.kdCurrentQuestionNo);
}

/** KD post-buzz window ran out: only the wrong cue plays; the admin marks manually. */
export function onKdDecisionExpired(env: PolicyEnv, owner: DecisionOwner | undefined): void {
  reopenKdBuzzer(env);
  if (owner === 'player') env.channel.emit('update-match-data', env.store.getMatch());
  env.channel.emit('play-sfx', SFX_WRONG);
  emitQuestionNumbers(env);
}

/** KD window cancelled (stop button, correct/wrong mark). */
export function onKdDecisionStopped(env: PolicyEnv, owner: DecisionOwner | undefined): void {
  if (owner !== 'player') return;
  reopenKdBuzzer(env);
  env.session.kdTurnPlayerIndex = NO_PLAYER;
}

/** VD steal window closed, whether by expiry or cancel. */
export function onVdStealClosed(env: PolicyEnv): void {
  env.session.vdStealWindowOpen = false;
  env.channel.emit('lock-button-vd');
}
