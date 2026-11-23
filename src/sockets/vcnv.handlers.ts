/**
 * VCNV (Vượt chướng ngại vật) realtime handlers.
 *
 * Ports the vcnv section of the old server.js monolith onto the canonical
 * contracts: persistence goes through MatchStore, player references are
 * 0-based indexes, and every game value comes from game.rules.
 *
 * Wire notes (kept for old-client parity):
 * - Question ids on the wire ('broadcast-vcnv-question', 'open-hn-vcnv',
 *   'close-hn-vcnv') are 1-based; converted to array indexes at this boundary.
 * - The obstacle-value recompute on full-round writes lives in the REST
 *   PUT /api/rounds/vcnv route, not here (the socket 'update-vcnv-data'
 *   request event was deleted per PLAN).
 */
import { Role } from '../contracts/api';
import { ObstacleBuzz, PlayerAnswer, VcnvQuestion } from '../contracts/game';
import { PLAYER_COUNT, VCNV_ROW_COUNT } from '../game.rules';
import { LogLevel } from '../logger';
import { emitRoundUpdate, sanitizeVcnvQuestion, sanitizeVcnvRound } from '../services/round-view';
import { NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

/** Broadcast in place of a question when the requested row is out of range. */
const EMPTY_QUESTION: Pick<VcnvQuestion, 'question'> = { question: '' };

/** H:M:S.ms, non-padded — exactly what the old server broadcast. */
function formatReadableTime(timestamp: number): string {
  const time = new Date(timestamp);
  return (
    `${time.getHours()}:${time.getMinutes()}:${time.getSeconds()}` +
    `.${time.getMilliseconds()}`
  );
}

function byTimestamp(a: ObstacleBuzz, b: ObstacleBuzz): number {
  return a.timestamp - b.timestamp;
}

/**
 * The 0-based player index of the caller: token identity first, legacy
 * verify-identity session registration as fallback; NO_PLAYER otherwise.
 */
function resolvePlayerIndex(ctx: HandlerContext): number {
  if (ctx.identity.roleId === Role.Player && ctx.identity.index !== undefined) {
    return ctx.identity.index;
  }
  return ctx.session.playerIndexOf(ctx.socket.id);
}

function isValidRowId(questionId: unknown, count: number): questionId is number {
  return (
    typeof questionId === 'number' &&
    Number.isInteger(questionId) &&
    questionId >= 1 &&
    questionId <= Math.min(VCNV_ROW_COUNT, count)
  );
}

export function registerVcnvHandlers(ctx: HandlerContext): void {
  const { io, room, socket, store, timer, log, rules } = ctx;
  const vcnv = store.round('vcnv');

  safeOn(ctx, 'mark-answer-vcnv', (marks: unknown) => {
    if (!isAdmin(ctx)) return;
    if (!Array.isArray(marks)) return;
    const match = store.updateMatch((m) => {
      for (let i = 0; i < Math.min(marks.length, PLAYER_COUNT); i++) {
        if (marks[i] === true) {
          m.players[i].score += rules.vcnvRowPoints;
          log(`Player ${m.players[i].name} got ${rules.vcnvRowPoints} points`);
        }
      }
    });
    io.emit('update-match-data', match);
  });

  safeOn(ctx, 'broadcast-vcnv-question', (questionId: unknown) => {
    if (!isStaff(ctx)) return;
    const questions = vcnv.get().questions;
    if (isValidRowId(questionId, questions.length)) {
      ctx.session.vcnvCurrentQuestionId = questionId;
      const q = questions[questionId - 1];
      room.staffChannel.emit('update-vcnv-question', q);
      room.publicChannel.emit('update-vcnv-question', sanitizeVcnvQuestion(q));
    } else {
      ctx.session.vcnvCurrentQuestionId = null;
      io.emit('update-vcnv-question', EMPTY_QUESTION);
    }
  });

  safeOn(ctx, 'highlight-vcnv-question', (questionId: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof questionId !== 'number' || !Number.isInteger(questionId)) return;
    ctx.session.vcnvHighlightedQuestionId = questionId >= 0 ? questionId : null;
    io.emit('update-highlighted-vcnv-question', questionId);
  });

  safeOn(ctx, 'submit-answer-vcnv', (answer: unknown) => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER || playerIndex < 0 || playerIndex >= PLAYER_COUNT) {
      log(`Socket ${socket.id} submitted a VCNV answer but is not a player`, LogLevel.Error);
      return;
    }
    if (typeof answer !== 'string' || answer.length > 500) return;
    const position = store.getMatch().position;
    const current = vcnv.get();
    if (!timer.isRunning() || current.showResults || position === 'VCNV_A') return;
    if (current.disabledPlayers.includes(playerIndex)) return;
    const data = vcnv.update((d) => {
      if (d.playerAnswers[playerIndex]) d.playerAnswers[playerIndex].answer = answer;
    });
    room.staffChannel.emit('update-vcnv-data', data);
    socket.emit('update-vcnv-data', sanitizeVcnvRound(data, position, playerIndex));
    socket.to(`${room.id}:public`).emit('update-vcnv-data', sanitizeVcnvRound(data, position));
  });

  safeOn(ctx, 'open-hn-vcnv', (questionId: unknown) => {
    if (!isAdmin(ctx)) return;
    if (!isValidRowId(questionId, vcnv.get().questions.length)) return;
    const data = vcnv.update((d) => {
      d.questions[questionId - 1].isOpen = true;
    });
    emitRoundUpdate(room, 'vcnv', data);
  });

  safeOn(ctx, 'close-hn-vcnv', (questionId: unknown) => {
    if (!isAdmin(ctx)) return;
    if (!isValidRowId(questionId, vcnv.get().questions.length)) return;
    const data = vcnv.update((d) => {
      d.questions[questionId - 1].isOpen = false;
    });
    emitRoundUpdate(room, 'vcnv', data);
  });

  safeOn(ctx, 'clear-player-answer', () => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER || playerIndex < 0 || playerIndex >= PLAYER_COUNT) {
      log(`Socket ${socket.id} tried to clear a VCNV answer but is not a player`, LogLevel.Error);
      return;
    }
    const position = store.getMatch().position;
    const current = vcnv.get();
    if (!timer.isRunning() || current.showResults || position === 'VCNV_A') return;
    if (current.disabledPlayers.includes(playerIndex)) return;
    const data = vcnv.update((d) => {
      if (!d.playerAnswers[playerIndex]) return;
      d.playerAnswers[playerIndex].answer = '';
      d.playerAnswers[playerIndex].correct = false;
    });
    room.staffChannel.emit('update-vcnv-data', data);
    socket.emit('update-vcnv-data', sanitizeVcnvRound(data, position, playerIndex));
    socket.to(`${room.id}:public`).emit('update-vcnv-data', sanitizeVcnvRound(data, position));
  });

  safeOn(ctx, 'submit-mark-vcnv-admin', (marked: unknown) => {
    if (!isAdmin(ctx)) return;
    if (!Array.isArray(marked)) return;
    const sanitizedMarks: PlayerAnswer[] = Array.from({ length: PLAYER_COUNT }, (_, i) => {
      const entry = marked[i] as Partial<PlayerAnswer> | undefined;
      return {
        answer: typeof entry?.answer === 'string' ? entry.answer : '',
        correct: entry?.correct === true,
      };
    });
    vcnv.update((d) => {
      d.playerAnswers = sanitizedMarks;
    });
    const match = store.updateMatch((m) => {
      for (let i = 0; i < PLAYER_COUNT; i++) {
        if (sanitizedMarks[i]?.correct === true) {
          m.players[i].score += rules.vcnvRowPoints;
          log(`Player ${m.players[i].name} got ${rules.vcnvRowPoints} points`);
        }
      }
    });
    io.emit('update-match-data', match);
  });

  safeOn(ctx, 'toggle-results-display-vcnv', () => {
    if (!isAdmin(ctx)) return;
    const data = vcnv.update((d) => {
      d.showResults = !d.showResults;
    });
    emitRoundUpdate(room, 'vcnv', data);
    log(data.showResults);
  });

  safeOn(ctx, 'attempt-cnv-player', () => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER || playerIndex < 0 || playerIndex >= PLAYER_COUNT) {
      log(`Socket ${socket.id} buzzed for the obstacle but is not a player`, LogLevel.Error);
      return;
    }
    if (vcnv.get().disabledPlayers.includes(playerIndex)) return;
    const timestamp = Date.now();
    const buzz: ObstacleBuzz = {
      playerIndex,
      timestamp,
      readableTime: formatReadableTime(timestamp),
    };
    const data = vcnv.update((d) => {
      d.disabledPlayers.push(playerIndex);
      d.obstacleBuzzes.push(buzz);
      d.obstacleBuzzes.sort(byTimestamp);
    });
    emitRoundUpdate(room, 'vcnv', data);
  });

  safeOn(ctx, 'submit-cnv-mark', (marks: unknown) => {
    if (!isAdmin(ctx)) return;
    if (!Array.isArray(marks)) return;
    const obstacleValue = vcnv.get().obstacle.value;
    const count = Math.min(marks.length, PLAYER_COUNT);
    const data = vcnv.update((d) => {
      for (let i = 0; i < count; i++) {
        if (marks[i] === false) d.disabledPlayers.push(i);
      }
      d.obstacleBuzzes = [];
    });
    const match = store.updateMatch((m) => {
      for (let i = 0; i < count; i++) {
        if (marks[i] === true && m.players[i]) {
          m.players[i].score += obstacleValue;
          log(`Player ${m.players[i].name} got ${obstacleValue} points`);
        }
      }
    });
    emitRoundUpdate(room, 'vcnv', data);
    io.emit('update-match-data', match);
  });
}
