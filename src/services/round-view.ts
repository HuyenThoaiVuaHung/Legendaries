import { Role } from '../contracts/api';
import {
  ChpQuestion,
  ChpRound,
  KdQuestion,
  KdRound,
  LiveStateSnapshot,
  MatchPosition,
  RoundData,
  RoundKind,
  TtQuestion,
  TtRound,
  VcnvQuestion,
  VcnvRound,
  VdQuestion,
  VdRound,
} from '../contracts/game';
import type { Room } from '../rooms/room';

const MS_PER_SECOND = 1000;
/** Decision-window remainders are reported in tenths of a second. */
const DECISION_STEP_MS = 100;

export const STAFF_ROUND_UPDATE_EVENTS: Readonly<Record<RoundKind, string>> = {
  kd: 'update-kd-data-admin',
  vcnv: 'update-vcnv-data',
  tt: 'update-tangtoc-data',
  vd: 'update-vedich-data',
  chp: 'update-chp-data',
};

export const PUBLIC_ROUND_UPDATE_EVENTS: Readonly<Record<RoundKind, string>> = {
  kd: 'update-kd-data',
  vcnv: 'update-vcnv-data',
  tt: 'update-tangtoc-data',
  vd: 'update-vedich-data',
  chp: 'update-chp-data',
};

export function isPrivilegedRole(role: Role): boolean {
  return role === Role.Admin || role === Role.Mc;
}

function maskAnswer(answer: string): string {
  return '*'.repeat(answer.replace(/\s+/g, '').length);
}

export function sanitizeKdQuestion(q: KdQuestion): KdQuestion {
  return { ...q, answer: '' };
}

export function sanitizeVcnvQuestion(q: VcnvQuestion): VcnvQuestion {
  if (q.isOpen) return q;
  return {
    ...q,
    question: q.isShown ? q.question : '',
    answer: maskAnswer(q.answer),
    ...(q.isShown ? {} : { imageFile: undefined, audioFile: undefined }),
  };
}

export function sanitizeTtQuestion(q: TtQuestion, showAnswer: boolean): TtQuestion {
  return {
    id: q.id,
    type: q.type,
    question: q.question,
    answer: '',
    ...(q.questionImage ? { questionImage: q.questionImage } : {}),
    ...(q.videoFile ? { videoFile: q.videoFile } : {}),
    ...(showAnswer && q.answerImage ? { answerImage: q.answerImage } : {}),
  };
}

export function sanitizeVdQuestion(q: VdQuestion): VdQuestion {
  return { ...q, answer: '' };
}

export function sanitizeChpQuestion(q: ChpQuestion): ChpQuestion {
  return { ...q, answer: '' };
}

export function sanitizeKdRound(kd: KdRound): Omit<KdRound, 'questions'> {
  const { questions, ...rest } = kd;
  void questions;
  return rest;
}

export function sanitizeVcnvRound(
  vcnv: VcnvRound,
  matchPosition: MatchPosition,
  playerIndex?: number,
): VcnvRound {
  const answersRevealed = vcnv.showResults || matchPosition === 'VCNV_A';
  return {
    ...vcnv,
    questions: vcnv.questions.map((q) => {
      const revealed = q.isShown || q.isOpen;
      const sanitized: VcnvQuestion = {
        id: q.id,
        type: q.type,
        value: q.value,
        isOpen: q.isOpen,
        isShown: q.isShown,
        question: revealed ? q.question : '',
        answer: q.isOpen ? q.answer : maskAnswer(q.answer),
      };
      if (revealed && q.imageFile !== undefined) sanitized.imageFile = q.imageFile;
      if (revealed && q.audioFile !== undefined) sanitized.audioFile = q.audioFile;
      return sanitized;
    }),
    obstacle: {
      value: vcnv.obstacle.value,
      question: '',
      answer: maskAnswer(vcnv.obstacle.answer),
      ...(vcnv.obstacle.imagePieceFiles ? { imagePieceFiles: vcnv.obstacle.imagePieceFiles } : {}),
    },
    playerAnswers: answersRevealed
      ? vcnv.playerAnswers
      : vcnv.playerAnswers.map((pa, idx) =>
          idx === playerIndex
            ? { answer: pa.answer, correct: false }
            : { answer: '', correct: false },
        ),
  };
}

export function sanitizeTtRound(
  tt: TtRound,
  matchPosition: MatchPosition,
  playerIndex?: number,
): TtRound {
  const answersRevealed = tt.showResults || matchPosition === 'TT_A';
  return {
    ...tt,
    questions: tt.questions.map((q, idx) =>
      idx === tt.activeQuestionIndex
        ? sanitizeTtQuestion(q, tt.showAnswer)
        : { id: q.id, type: q.type, question: '', answer: '' },
    ),
    playerAnswers: answersRevealed
      ? tt.playerAnswers
      : tt.playerAnswers.map((pa) =>
          pa.playerIndex === playerIndex
            ? { ...pa, correct: false }
            : { playerIndex: pa.playerIndex, answer: '', timestamp: 0, readableTime: '', correct: false },
        ),
  };
}

export function sanitizeVdRound(vd: VdRound): VdRound {
  return {
    ...vd,
    questionPools: vd.questionPools.map((pool) =>
      pool.map((q) => ({ value: q.value, type: q.type, question: '', answer: '' })),
    ),
  };
}

export function sanitizeChpRound(chp: ChpRound): ChpRound {
  return {
    ...chp,
    questions: [],
  };
}

export function sanitizeRoundForRole(
  kind: RoundKind,
  data: RoundData,
  role: Role,
  matchPosition: MatchPosition,
  playerIndex?: number,
): RoundData | Omit<KdRound, 'questions'> {
  if (isPrivilegedRole(role)) return data;
  switch (kind) {
    case 'kd':
      return sanitizeKdRound(data as KdRound);
    case 'vcnv':
      return sanitizeVcnvRound(data as VcnvRound, matchPosition, playerIndex);
    case 'tt':
      return sanitizeTtRound(data as TtRound, matchPosition, playerIndex);
    case 'vd':
      return sanitizeVdRound(data as VdRound);
    case 'chp':
      return sanitizeChpRound(data as ChpRound);
  }
}

export function emitRoundUpdate(room: Room, kind: RoundKind, data: RoundData): void {
  room.staffChannel.emit(STAFF_ROUND_UPDATE_EVENTS[kind], data);
  const publicView = sanitizeRoundForRole(
    kind,
    data,
    Role.Viewer,
    room.store.getMatch().position,
  );
  room.publicChannel.emit(PUBLIC_ROUND_UPDATE_EVENTS[kind], publicView);
}

/**
 * Build a role-sanitized snapshot of all ephemeral live state in `room` so
 * refreshing, reconnecting, or late-joining clients resume cleanly without
 * waiting for the next event or leaking hidden answers.
 */
export function buildLiveStateSnapshot(room: Room, role: Role): LiveStateSnapshot {
  const now = Date.now();
  const privileged = isPrivilegedRole(role);
  const { session, store, timers } = room;
  const kdWindow = timers.kdDecision;
  const vdWindow = timers.vdSteal;
  const main = timers.main;
  const mainShown = main.isRunning() || main.isPaused() || main.status === 'pending';

  let activeTimedSfx = session.activeTimedSfx;
  if (
    activeTimedSfx &&
    activeTimedSfx.durationMs !== undefined &&
    now - activeTimedSfx.startedAt >= activeTimedSfx.durationMs
  ) {
    session.activeTimedSfx = null;
    activeTimedSfx = null;
  }

  const vcnv = store.round('vcnv').get();
  const vcnvRaw =
    session.vcnvCurrentQuestionId !== null
      ? (vcnv.questions[session.vcnvCurrentQuestionId - 1] ?? null)
      : (vcnv.questions.find((q) => q.isShown) ?? null);

  const tt = store.round('tt').get();
  const ttRaw =
    tt.activeQuestionIndex >= 0 ? (tt.questions[tt.activeQuestionIndex] ?? null) : null;

  return {
    serverTime: now,
    clock: {
      running: main.isRunning(),
      remaining: Math.ceil(main.remainingMs() / MS_PER_SECOND),
      maxSeconds: mainShown ? main.durationMs / MS_PER_SECOND : 0,
      paused: main.isPaused(),
    },
    timers: timers.snapshot(),
    activeLoopSfx: session.activeLoopSfx ? { ...session.activeLoopSfx } : null,
    activeTimedSfx: activeTimedSfx ? { ...activeTimedSfx } : null,
    kd: {
      question: session.kdCurrentQuestion
        ? privileged
          ? session.kdCurrentQuestion
          : sanitizeKdQuestion(session.kdCurrentQuestion)
        : null,
      previousAnswer: session.kdPreviousAnswer,
      turnPlayerIndex: session.kdTurnPlayerIndex,
      buzzerOpen: session.kdBuzzerOpen,
      maxQuestionCount: session.kdMaxQuestionCount,
      currentQuestionNo: session.kdCurrentQuestionNo,
      decisionTimerOwner: kdWindow.isLive() ? (kdWindow.owner ?? 'none') : 'none',
      decisionRemaining: Math.ceil(kdWindow.remainingMs() / DECISION_STEP_MS),
      flow: room.kdFlow.state(),
    },
    vcnv: {
      question: vcnvRaw ? (privileged ? vcnvRaw : sanitizeVcnvQuestion(vcnvRaw)) : null,
      highlightedQuestionId: session.vcnvHighlightedQuestionId,
    },
    tt: {
      question: ttRaw
        ? privileged
          ? ttRaw
          : sanitizeTtQuestion(ttRaw, tt.showAnswer)
        : null,
      videoPlaying: session.ttVideo.playing,
      videoStartedAt: session.ttVideo.startedAt,
      video: { ...session.ttVideo },
    },
    vd: {
      question: session.vdCurrentQuestion
        ? privileged
          ? session.vdCurrentQuestion
          : sanitizeVdQuestion(session.vdCurrentQuestion)
        : null,
      stealingPlayerIndex: session.vdStealingPlayerIndex,
      stealWindowOpen: session.vdStealWindowOpen,
      stealRemaining: Math.ceil(vdWindow.remainingMs() / DECISION_STEP_MS),
      videoPlaying: session.vdVideo.playing,
      videoStartedAt: session.vdVideo.startedAt,
      video: { ...session.vdVideo },
    },
    chp: {
      question: session.chpCurrentQuestion
        ? privileged
          ? session.chpCurrentQuestion
          : sanitizeChpQuestion(session.chpCurrentQuestion)
        : null,
      turnPlayerIndex: session.chpTurnPlayerIndex,
      buzzerOpen: session.chpBuzzerOpen,
    },
  };
}
