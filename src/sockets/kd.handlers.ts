import { Role } from '../contracts/api';
import { KdMarkCommand, KdMarkRejected, KdQuestion, KdVerdict } from '../contracts/game';
import { LogLevel } from '../logger';
import { sanitizeKdQuestion } from '../services/round-view';
import { NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

/** Player index of the acting socket, or NO_PLAYER when it isn't a player. */
function resolvePlayerIndex(ctx: HandlerContext): number {
  if (ctx.identity.roleId === Role.Player && ctx.identity.index !== undefined) {
    return ctx.identity.index;
  }
  return ctx.session.playerIndexOf(ctx.socket.id);
}

function isKdQuestion(value: unknown): value is KdQuestion {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as KdQuestion).question === 'string' &&
    typeof (value as KdQuestion).answer === 'string' &&
    typeof (value as KdQuestion).type === 'string'
  );
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function registerKdHandlers(ctx: HandlerContext): void {
  const { io, room, socket, store, session, timers, log, rules } = ctx;
  const kd = store.round('kd');
  const flow = room.kdFlow;

  /** Mark payload; clients that send none are graded against the current state. */
  const parseMark = (raw: unknown): KdMarkCommand | null => {
    if (raw === undefined || raw === null) return { questionSeq: flow.questionSeq, playerIndex: session.kdTurnPlayerIndex };
    const cmd = raw as Partial<KdMarkCommand>;
    return isInt(cmd.questionSeq) && isInt(cmd.playerIndex) ? { questionSeq: cmd.questionSeq, playerIndex: cmd.playerIndex } : null;
  };

  const reject = (reason: KdMarkRejected['reason']): void => {
    const rejected: KdMarkRejected = { reason, questionSeq: flow.questionSeq, turnPlayerIndex: session.kdTurnPlayerIndex };
    socket.emit('kd-mark-rejected', rejected);
  };

  const markMultiplayer = (verdict: KdVerdict, raw: unknown): void => {
    const cmd = parseMark(raw);
    if (!cmd) return;
    const reason = flow.mark(verdict, cmd);
    if (reason) reject(reason);
  };

  const emitQuestionNumbers = (): void => {
    io.emit(
      'update-number-question-kd',
      session.kdMaxQuestionCount,
      session.kdCurrentQuestionNo,
    );
  };

  /**
   * Wrong answer in multiplayer: apply the penalty, but only to players with
   * points to lose (the old server never let KD scores go negative here).
   * Callers broadcast 'update-match-data' themselves.
   */
  const penalizePlayer = (playerIndex: number): void => {
    store.updateMatch((m) => {
      const player = m.players[playerIndex];
      if (!player || player.score <= 0) return;
      player.score -= rules.kdWrongPenalty;
      log(`Player ${player.name} lost ${rules.kdWrongPenalty} points`);
    });
  };

  safeOn(ctx, 'broadcast-kd-question', (question: unknown, replacesSeq?: unknown) => {
    if (!isStaff(ctx)) return;
    if (!isKdQuestion(question)) return;
    const multiplayer = flow.isMultiplayer();
    // Several admins may auto-advance after one grade; only the first lands.
    if (multiplayer && isInt(replacesSeq) && replacesSeq !== flow.questionSeq) return;
    session.kdPreviousAnswer = session.kdCurrentQuestion?.answer || null;
    session.kdCurrentQuestion = question;
    session.kdTurnPlayerIndex = NO_PLAYER;
    socket.to(`${room.id}:staff`).emit('update-kd-question', question);
    socket.to(`${room.id}:public`).emit('update-kd-question', sanitizeKdQuestion(question));
    if (multiplayer) flow.beginQuestion();
  });

  safeOn(ctx, 'clear-question-kd', () => {
    if (!isStaff(ctx)) return;
    session.kdPreviousAnswer = session.kdCurrentQuestion?.answer || null;
    session.kdCurrentQuestion = null;
    session.kdTurnPlayerIndex = NO_PLAYER;
    socket.to(room.id).emit('update-kd-question', {});
    if (flow.isMultiplayer()) flow.reset();
  });

  safeOn(ctx, 'get-turn-kd', () => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER) return;
    if (kd.get().gamemode !== 'M') return;
    if (flow.buzz(playerIndex)) return;
    if (session.kdTurnPlayerIndex !== NO_PLAYER) {
      // First buzz wins; late presses are only logged.
      log(`Player ${playerIndex} requested turn`);
    }
  });

  safeOn(ctx, 'clear-turn-kd', () => {
    if (!isStaff(ctx)) return;
    log('Cleared turn khoi dong');
    if (flow.isMultiplayer()) {
      flow.restartBuzzWindow();
      return;
    }
    session.kdTurnPlayerIndex = NO_PLAYER;
    session.kdBuzzerOpen = true;
    io.emit('clear-turn-player-kd');
    io.emit('enable-answer-button-kd');
  });

  safeOn(ctx, 'clear-turn-kd-f', () => {
    if (!isStaff(ctx)) return;
    if (flow.isMultiplayer()) flow.freezeAnswer();
    session.kdTurnPlayerIndex = NO_PLAYER;
    session.kdBuzzerOpen = false;
    io.emit('clear-turn-player-kd');
  });

  safeOn(ctx, 'correct-mark-kd', (raw?: unknown) => {
    if (!isAdmin(ctx)) return;
    if (flow.isMultiplayer()) {
      markMultiplayer('correct', raw);
      return;
    }
    session.kdBuzzerOpen = true;
    io.emit('enable-answer-button-kd');
    session.kdCurrentQuestionNo += 1;
    log(`Current question no: ${session.kdCurrentQuestionNo}`);
    emitQuestionNumbers();

    const data = kd.get();
    const holder = session.kdTurnPlayerIndex;
    if (data.gamemode === 'S') {
      store.updateMatch((m) => {
        const player = m.players[data.activePlayerIndex];
        if (!player) return;
        player.score += rules.kdCorrectPoints;
        log(`Player ${player.name} got ${rules.kdCorrectPoints} points`);
      });
    } else if (data.gamemode === 'M' && holder !== NO_PLAYER) {
      store.updateMatch((m) => {
        const player = m.players[holder];
        if (!player) return;
        player.score += rules.kdCorrectPoints;
        log(`Player ${player.name} got ${rules.kdCorrectPoints} points`);
      });
    }

    io.emit('update-match-data', store.getMatch());
    session.kdTurnPlayerIndex = NO_PLAYER;
    timers.stopKdDecision();
  });

  safeOn(ctx, 'wrong-mark-kd', (raw?: unknown) => {
    if (!isAdmin(ctx)) return;
    if (flow.isMultiplayer()) {
      markMultiplayer('wrong', raw);
      return;
    }
    session.kdBuzzerOpen = true;
    io.emit('enable-answer-button-kd');

    if (kd.get().gamemode === 'M') {
      const holder = session.kdTurnPlayerIndex;
      if (holder === NO_PLAYER) log('wrong-mark-kd with no turn holder', LogLevel.Warn);
      else penalizePlayer(holder);
    }

    session.kdCurrentQuestionNo += 1;
    log(`Current question no: ${session.kdCurrentQuestionNo}`);
    emitQuestionNumbers();
    io.emit('update-match-data', store.getMatch());
    session.kdTurnPlayerIndex = NO_PLAYER;
    timers.stopKdDecision();
  });

  safeOn(ctx, 'no-answer-kd', (raw?: unknown) => {
    if (!isAdmin(ctx) || !flow.isMultiplayer()) return;
    markMultiplayer('noAnswer', raw);
  });

  safeOn(ctx, 'undo-mark-kd', () => {
    if (!isAdmin(ctx) || !flow.isMultiplayer()) return;
    const reason = flow.undo();
    if (reason) reject(reason);
  });

  safeOn(ctx, 'stop-kd-sound', () => {
    if (!isStaff(ctx)) return;
    session.activeLoopSfx = null;
    session.activeTimedSfx = null;
    io.emit('stop-kd-sound');
  });

  safeOn(ctx, 'update-number-question-kd', (maxCount: unknown, currentNo: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof maxCount !== 'number' || !Number.isInteger(maxCount) || maxCount < 0) return;
    if (typeof currentNo !== 'number' || !Number.isInteger(currentNo) || currentNo < 0) return;
    session.kdMaxQuestionCount = maxCount;
    session.kdCurrentQuestionNo = currentNo;
    emitQuestionNumbers();
  });

  safeOn(ctx, 'start-turn-kd', (questionCount: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof questionCount !== 'number' || !Number.isInteger(questionCount) || questionCount < 0) return;
    session.kdCurrentQuestionNo = 0;
    session.kdMaxQuestionCount = questionCount;
    session.kdCurrentQuestion = null;
    session.kdPreviousAnswer = null;
    session.kdTurnPlayerIndex = NO_PLAYER;
    emitQuestionNumbers();
    if (flow.isMultiplayer()) {
      flow.reset();
    } else {
      session.kdBuzzerOpen = true;
      io.emit('enable-answer-button-kd');
    }
    io.emit('update-questions-number-kd', questionCount);
  });

  // Post-buzz decision window (rules.kdDecisionMs). Expiry only plays the
  // wrong cue; the admin marks the answer or skips the question manually.
  safeOn(ctx, 'start-3s-timer-kd', (isPlayerTimer: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof isPlayerTimer !== 'boolean') return;
    // Multiplayer: the server runs the windows; this is only a legacy nudge.
    if (flow.isMultiplayer()) {
      if (isPlayerTimer) flow.resumeAnswer();
      else flow.restartBuzzWindow();
      return;
    }
    timers.startKdDecision(isPlayerTimer);
  });

  safeOn(ctx, 'stop-3s-timer-kd', () => {
    if (!isStaff(ctx)) return;
    if (flow.isMultiplayer()) {
      flow.freezeAnswer();
      return;
    }
    timers.stopKdDecision();
  });
}
