/**
 * TT (Tăng tốc) realtime handlers.
 *
 * Ports the tangtoc section of the old server.js monolith onto the canonical
 * contracts: persistence goes through MatchStore, player references are
 * 0-based indexes (the old code awarded via `markData[i].id - 1` on 1-based
 * ids — canonical TtAnswer.playerIndex is already 0-based), and every game
 * value comes from game.rules.
 *
 * Wire note: 'broadcast-tt-question' carries a 1-based question id, with -1
 * meaning "clear the broadcast question"; converted at this boundary.
 */
import { Role } from '../contracts/api';
import { TtAnswer } from '../contracts/game';
import { PLAYER_COUNT } from '../game.rules';
import { LogLevel } from '../logger';
import { emitRoundUpdate, sanitizeTtQuestion, sanitizeTtRound } from '../services/round-view';
import { NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

/** Sentinel the admin UI sends to clear the broadcast question. */
const NO_QUESTION_ID = -1;

/** H:M:S.ms, non-padded — exactly what the old server broadcast. */
function formatReadableTime(timestamp: number): string {
  const time = new Date(timestamp);
  return (
    `${time.getHours()}:${time.getMinutes()}:${time.getSeconds()}` +
    `.${time.getMilliseconds()}`
  );
}

/** Server-measured elapsed time when both have it, else arrival timestamp. */
function byRank(a: TtAnswer, b: TtAnswer): number {
  if (a.elapsedMs !== undefined && b.elapsedMs !== undefined) return a.elapsedMs - b.elapsedMs;
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

export function registerTtHandlers(ctx: HandlerContext): void {
  const { io, room, socket, store, timers, log, rules } = ctx;
  const tt = store.round('tt');

  safeOn(ctx, 'player-submit-answer-tangtoc', (answer: unknown) => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER || playerIndex < 0 || playerIndex >= PLAYER_COUNT) {
      log(`Socket ${socket.id} submitted a TT answer but is not a player`, LogLevel.Error);
      return;
    }
    if (typeof answer !== 'string' || answer.length > 500) return;
    const arrival = room.time.mono();
    const position = store.getMatch().position;
    const current = tt.get();
    if (
      !timers.main.acceptsAt(arrival, rules.submissionGraceMs) ||
      current.showResults ||
      current.showAnswer ||
      position === 'TT_A' ||
      current.activeQuestionIndex < 0
    ) {
      return;
    }
    const timestamp = Date.now();
    const elapsedMs = Math.round(timers.main.activeElapsedMs(arrival));
    const data = tt.update((d) => {
      const entry = d.playerAnswers[playerIndex];
      if (!entry) return;
      entry.answer = answer;
      entry.elapsedMs = elapsedMs;
      entry.timestamp = timestamp;
      entry.readableTime = formatReadableTime(timestamp);
    });
    room.staffChannel.emit('update-tangtoc-data', data);
    socket.emit('update-tangtoc-data', sanitizeTtRound(data, position, playerIndex));
    socket.to(`${room.id}:public`).emit('update-tangtoc-data', sanitizeTtRound(data, position));
  });

  safeOn(ctx, 'update-timer-start-timestamp', () => {
    if (!isAdmin(ctx)) return;
    // Legacy: the server now stamps this itself in 'start-clock'.
    const startsAt = timers.main.startsAtMono;
    if (!timers.main.isLive() || startsAt === null) return;
    const data = tt.update((d) => {
      d.timerStartTimestamp = room.time.epoch(startsAt);
    });
    emitRoundUpdate(room, 'tt', data);
  });

  safeOn(ctx, 'submit-mark-tangtoc-admin', () => {
    if (!isAdmin(ctx)) return;
    const ranked = [...tt.get().playerAnswers].sort(byRank);
    const match = store.updateMatch((m) => {
      let placement = 0;
      let last: TtAnswer | null = null;
      let lastPoints = 0;
      for (const answer of ranked) {
        if (answer.correct !== true) continue;
        const player = m.players[answer.playerIndex];
        if (!player) continue;
        const points =
          last !== null && byRank(last, answer) === 0
            ? lastPoints
            : (rules.ttPointsByPlacement[placement] ?? 0);
        last = answer;
        lastPoints = points;
        player.score += points;
        log(`Player ${player.name} got ${points} points`);
        placement++;
      }
    });
    io.emit('update-match-data', match);
  });

  safeOn(ctx, 'toggle-results-display-tangtoc', () => {
    if (!isAdmin(ctx)) return;
    const data = tt.update((d) => {
      d.showResults = !d.showResults;
    });
    emitRoundUpdate(room, 'tt', data);
  });

  safeOn(ctx, 'broadcast-tt-question', (questionId: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof questionId !== 'number' || !Number.isInteger(questionId)) return;
    const resetVideo = ctx.session.resetVideoPlayback('tt');
    io.emit('video-state', { target: 'tt', state: resetVideo, serverTime: Date.now() });
    if (questionId !== NO_QUESTION_ID) {
      const current = tt.get();
      const index = current.questions.findIndex((item) => item.id === questionId);
      const resolvedIndex = index >= 0 ? index : questionId - 1;
      const q = current.questions[resolvedIndex];
      if (!q) {
        const cleared = tt.update((d) => {
          d.activeQuestionIndex = NO_QUESTION_ID;
        });
        emitRoundUpdate(room, 'tt', cleared);
        io.emit('update-tangtoc-question', undefined);
        return;
      }
      const updated = tt.update((d) => {
        d.activeQuestionIndex = resolvedIndex;
      });
      emitRoundUpdate(room, 'tt', updated);
      room.staffChannel.emit('update-tangtoc-question', q);
      room.publicChannel.emit('update-tangtoc-question', sanitizeTtQuestion(q, updated.showAnswer));
    } else {
      const cleared = tt.update((d) => {
        d.activeQuestionIndex = NO_QUESTION_ID;
      });
      emitRoundUpdate(room, 'tt', cleared);
      io.emit('update-tangtoc-question', undefined);
    }
  });

  safeOn(ctx, 'clear-answer-tt', () => {
    if (!isAdmin(ctx)) return;
    const data = tt.update((d) => {
      d.playerAnswers = Array.from(
        { length: PLAYER_COUNT },
        (_, playerIndex): TtAnswer => ({
          playerIndex,
          answer: '',
          timestamp: 0,
          readableTime: '',
          correct: false,
        }),
      );
    });
    emitRoundUpdate(room, 'tt', data);
  });

  safeOn(ctx, 'tangtoc-play-video', () => {
    if (!isStaff(ctx)) return;
    const now = Date.now();
    const state = ctx.session.applyVideoControl('tt', { target: 'tt', action: 'toggle' }, now);
    io.emit('video-state', { target: 'tt', state, serverTime: now });
    io.emit('tangtoc-play-video');
  });
}
