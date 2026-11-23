/**
 * Every tunable game rule and timing value. Defaults live here; a `rules`
 * section in utils/config.json (or LEGENDARY_RULES_* env vars) overrides any
 * of them, so operators can retune scoring/timers without a rebuild.
 *
 * Structural invariants that the code's shape depends on (board indices, piece
 * geometry) are NOT knobs and stay as plain constants below.
 */

import type { KdTimeUpMode } from './contracts/game';

const KD_TIME_UP_MODES: readonly KdTimeUpMode[] = ['manual', 'autoWrong'];

export interface GameRules {
  playerCount: number;
  /** Delay before a started main clock begins counting, per round. */
  clockStartDelayMs: Record<ClockRound, number>;
  /** Late-submission window after the main clock expires. */
  submissionGraceMs: number;

  kdCorrectPoints: number;
  kdWrongPenalty: number;
  kdDecisionMs: number;
  /** Multiplayer KD: pause between a question going out and the buzzer opening. */
  kdBuzzArmDelayMs: number;
  /** Multiplayer KD: how long the buzzer stays open for the first press. */
  kdBuzzWindowMs: number;
  /** Multiplayer KD: what a lapsed answer/buzz window does. Changes apply at the next expiry. */
  kdTimeUpMode: KdTimeUpMode;

  vcnvRowPoints: number;
  /** Obstacle value indexed by number of revealed rows (0..VCNV_ROW_COUNT). */
  obstacleValueByRevealedCount: Record<number, number>;

  /** Points by finishing order for the Tăng tốc round (1st, 2nd, …). */
  ttPointsByPlacement: number[];
  /** Thinking time in seconds for each Tăng tốc question (e.g. [20, 20, 30, 30] for O25/O26). */
  ttQuestionSeconds: number[];
  /** Countdown while the Tăng tốc video question plays. */
  ttVideoSeconds: number;

  vdStealMs: number;
  vdWrongPenaltyDivisor: number;
  vdHopeStarMultiplier: number;

  chpTurnSeconds: number;
  chpCorrectPoints: number;
}

export const CLOCK_ROUNDS = ['KD', 'VCNV', 'TT', 'VD', 'CHP'] as const;
export type ClockRound = (typeof CLOCK_ROUNDS)[number];

/** Rounds whose pre-split single start delay (kdClockStartDelayMs) applied. */
const LEGACY_DELAY_ROUNDS: readonly ClockRound[] = ['KD', 'VCNV', 'TT', 'VD'];
/** Old decision windows were counted in ticks of this length. */
const LEGACY_DECISION_TICK_MS = 100;

/** Rule keys from before the clock overhaul; still accepted on load and PATCH. */
export interface LegacyGameRules {
  mainClockTickMs?: number;
  decisionTickMs?: number;
  kdDecisionTicks?: number;
  kdClockStartDelayMs?: number;
  vdStealTicks?: number;
}

const LEGACY_KEYS: readonly (keyof LegacyGameRules)[] = [
  'mainClockTickMs',
  'decisionTickMs',
  'kdDecisionTicks',
  'kdClockStartDelayMs',
  'vdStealTicks',
];

export const DEFAULT_GAME_RULES: GameRules = {
  playerCount: 4,

  clockStartDelayMs: { KD: 1000, VCNV: 1000, TT: 1000, VD: 1000, CHP: 0 },
  submissionGraceMs: 250,

  kdCorrectPoints: 10,
  kdWrongPenalty: 5,
  kdDecisionMs: 3000,
  kdBuzzArmDelayMs: 300,
  kdBuzzWindowMs: 3000,
  kdTimeUpMode: 'manual',

  vcnvRowPoints: 10,
  obstacleValueByRevealedCount: { 0: 60, 1: 60, 2: 50, 3: 40, 4: 30, 5: 20 },

  ttPointsByPlacement: [40, 30, 20, 10],
  ttQuestionSeconds: [20, 20, 30, 30],
  ttVideoSeconds: 30,

  vdStealMs: 5000,
  vdWrongPenaltyDivisor: 2,
  vdHopeStarMultiplier: 2,

  chpTurnSeconds: 15,
  chpCorrectPoints: 1,
};

/**
 * Merge operator overrides over the defaults into a rules object.
 * Deliberately NOT frozen: the live settings menu mutates this shared object
 * in place (via applyRuleOverrides) so running handlers pick up new values.
 */
export function loadGameRules(raw?: Partial<GameRules> & LegacyGameRules): GameRules {
  const overrides = raw ? migrateLegacyRules(raw) : undefined;
  const rules: GameRules = { ...DEFAULT_GAME_RULES, ...overrides };
  if (!KD_TIME_UP_MODES.includes(rules.kdTimeUpMode)) rules.kdTimeUpMode = DEFAULT_GAME_RULES.kdTimeUpMode;
  rules.clockStartDelayMs = { ...DEFAULT_GAME_RULES.clockStartDelayMs, ...overrides?.clockStartDelayMs };
  rules.obstacleValueByRevealedCount = {
    ...DEFAULT_GAME_RULES.obstacleValueByRevealedCount,
    ...overrides?.obstacleValueByRevealedCount,
  };
  rules.ttPointsByPlacement = [
    ...(overrides?.ttPointsByPlacement ?? DEFAULT_GAME_RULES.ttPointsByPlacement),
  ];
  rules.ttQuestionSeconds = [
    ...(overrides?.ttQuestionSeconds ?? DEFAULT_GAME_RULES.ttQuestionSeconds),
  ];
  return rules;
}

/** Map pre-overhaul keys onto the current ones and drop them; new keys win. */
export function migrateLegacyRules(raw: Partial<GameRules> & LegacyGameRules): Partial<GameRules> {
  const migrated: Partial<GameRules> & LegacyGameRules = { ...raw };
  const tickMs = validLegacyNumber(raw.decisionTickMs) ?? LEGACY_DECISION_TICK_MS;
  const delay = validLegacyNumber(raw.kdClockStartDelayMs);
  if (delay !== undefined) {
    const perRound = {} as Record<ClockRound, number>;
    for (const round of LEGACY_DELAY_ROUNDS) perRound[round] = delay;
    migrated.clockStartDelayMs = { ...perRound, ...raw.clockStartDelayMs };
  }
  const decisionTicks = validLegacyNumber(raw.kdDecisionTicks);
  if (decisionTicks !== undefined && raw.kdDecisionMs === undefined) migrated.kdDecisionMs = decisionTicks * tickMs;
  const stealTicks = validLegacyNumber(raw.vdStealTicks);
  if (stealTicks !== undefined && raw.vdStealMs === undefined) migrated.vdStealMs = stealTicks * tickMs;
  for (const key of LEGACY_KEYS) delete migrated[key];
  return migrated;
}

function validLegacyNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Major rule differences by Olympia season (23, 24, 25, 26). */
export function rulesForMatchVersion(version: number): Partial<GameRules> {
  if (version === 23) {
    return {
      obstacleValueByRevealedCount: { 0: 50, 1: 50, 2: 40, 3: 30, 4: 20, 5: 10 },
      ttQuestionSeconds: [10, 20, 30, 40],
    };
  }
  if (version === 24) {
    return {
      obstacleValueByRevealedCount: { 0: 60, 1: 60, 2: 50, 3: 40, 4: 30, 5: 20 },
      ttQuestionSeconds: [10, 20, 30, 40],
    };
  }
  return {
    obstacleValueByRevealedCount: { 0: 60, 1: 60, 2: 50, 3: 40, 4: 30, 5: 20 },
    ttQuestionSeconds: [20, 20, 30, 30],
  };
}

interface NumericRuleConstraint {
  minimum: number;
}

/** Numeric rule fields that the settings menu may edit, with safe lower bounds. */
export const TUNABLE_NUMBER_FIELDS = {
  submissionGraceMs: { minimum: 0 },
  kdCorrectPoints: { minimum: 0 },
  kdWrongPenalty: { minimum: 0 },
  kdDecisionMs: { minimum: 1 },
  kdBuzzArmDelayMs: { minimum: 0 },
  kdBuzzWindowMs: { minimum: 1 },
  vcnvRowPoints: { minimum: 0 },
  ttVideoSeconds: { minimum: 1 },
  vdStealMs: { minimum: 1 },
  vdWrongPenaltyDivisor: { minimum: 1 },
  vdHopeStarMultiplier: { minimum: 1 },
  chpTurnSeconds: { minimum: 1 },
  chpCorrectPoints: { minimum: 0 },
} as const satisfies Record<
  Exclude<keyof GameRules, 'playerCount' | 'kdTimeUpMode' | 'clockStartDelayMs' | 'obstacleValueByRevealedCount' | 'ttPointsByPlacement' | 'ttQuestionSeconds'>,
  NumericRuleConstraint
>;

/**
 * Apply a partial update onto an existing rules object, in place. Structural
 * values (the player count and board geometry) are deliberately excluded.
 * Invalid values are ignored and never persisted or broadcast.
 */
export function applyRuleOverrides(rules: GameRules, rawPatch: Partial<GameRules> & LegacyGameRules): string[] {
  const changed: string[] = [];
  const patch = migrateLegacyRules(rawPatch);

  if (patch.clockStartDelayMs && typeof patch.clockStartDelayMs === 'object') {
    let updated = false;
    for (const round of CLOCK_ROUNDS) {
      const value = patch.clockStartDelayMs[round];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        rules.clockStartDelayMs[round] = value;
        updated = true;
      }
    }
    if (updated) changed.push('clockStartDelayMs');
  }

  for (const [field, constraint] of Object.entries(TUNABLE_NUMBER_FIELDS) as [
    keyof typeof TUNABLE_NUMBER_FIELDS,
    NumericRuleConstraint,
  ][]) {
    const value = patch[field];
    if (typeof value === 'number' && Number.isFinite(value) && value >= constraint.minimum) {
      rules[field] = value;
      changed.push(field);
    }
  }

  if (typeof patch.kdTimeUpMode === 'string' && KD_TIME_UP_MODES.includes(patch.kdTimeUpMode)) {
    rules.kdTimeUpMode = patch.kdTimeUpMode;
    changed.push('kdTimeUpMode');
  }

  if (Array.isArray(patch.ttPointsByPlacement)) {
    const points = patch.ttPointsByPlacement;
    const valid =
      points.length === PLAYER_COUNT &&
      points.every((value) => Number.isFinite(value) && value >= 0);
    if (valid) {
      rules.ttPointsByPlacement = [...points];
      changed.push('ttPointsByPlacement');
    }
  }

  if (Array.isArray(patch.ttQuestionSeconds)) {
    const seconds = patch.ttQuestionSeconds;
    const valid =
      seconds.length >= 1 &&
      seconds.length <= 6 &&
      seconds.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 1);
    if (valid) {
      rules.ttQuestionSeconds = [...seconds];
      changed.push('ttQuestionSeconds');
    }
  }

  if (patch.obstacleValueByRevealedCount && typeof patch.obstacleValueByRevealedCount === 'object') {
    let updated = false;
    for (const [key, value] of Object.entries(patch.obstacleValueByRevealedCount)) {
      const revealedCount = Number(key);
      if (
        Number.isInteger(revealedCount) &&
        revealedCount >= 0 &&
        revealedCount <= VCNV_ROW_COUNT &&
        Number.isFinite(value) &&
        value >= 0
      ) {
        rules.obstacleValueByRevealedCount[revealedCount] = value;
        updated = true;
      }
    }
    if (updated) changed.push('obstacleValueByRevealedCount');
  }

  return changed;
}

// --------------------------------------------------------- structural invariants

/** Players per match — the board, timers and arrays are all sized to this. */
export const PLAYER_COUNT = DEFAULT_GAME_RULES.playerCount;
/** Number of hàng ngang rows; fixed by the board layout. */
export const VCNV_ROW_COUNT = 5;
/** Reveal-piece count, fixed by the 4-corners-plus-centre geometry. */
export const VCNV_PIECE_COUNT = 5;
