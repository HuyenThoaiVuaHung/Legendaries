import { Role } from '../contracts/api';
import { KdQuestion } from '../contracts/game';
import { LogLevel } from '../logger';
import { sanitizeKdQuestion } from '../services/round-view';
import { DecisionTimerOwner, NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

// Sound-effect identifiers understood by the frontend (protocol vocabulary,
// names kept from the old client).
const SFX_GET_TURN = 'KD_GET_TURN';
const SFX_WRONG = 'KD_WRONG';

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

export function registerKdHandlers(ctx: HandlerContext): void {
  const { io, room, socket, store, session, timer, log, rules } = ctx;
  const kd = store.round('kd');

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

  safeOn(ctx, 'broadcast-kd-question', (question: unknown) => {
    if (!isStaff(ctx)) return;
    if (!isKdQuestion(question)) return;
    session.kdPreviousAnswer = session.kdCurrentQuestion?.answer || null;
    session.kdCurrentQuestion = question;
    session.kdTurnPlayerIndex = NO_PLAYER;
    socket.to(`${room.id}:staff`).emit('update-kd-question', question);
    socket.to(`${room.id}:public`).emit('update-kd-question', sanitizeKdQuestion(question));
  });

  safeOn(ctx, 'clear-question-kd', () => {
    if (!isStaff(ctx)) return;
    session.kdPreviousAnswer = session.kdCurrentQuestion?.answer || null;
    session.kdCurrentQuestion = null;
    session.kdTurnPlayerIndex = NO_PLAYER;
    socket.to(room.id).emit('update-kd-question', {});
  });

  safeOn(ctx, 'get-turn-kd', () => {
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER) return;
    if (kd.get().gamemode !== 'M' || !session.kdBuzzerOpen) return;
    if (session.kdTurnPlayerIndex !== NO_PLAYER) {
      // First buzz wins; late presses are only logged.
      log(`Player ${playerIndex} requested turn`);
      return;
    }
    io.emit('play-sfx', SFX_GET_TURN);
    session.kdDecisionTimerOwner = DecisionTimerOwner.Player;
    session.kdTurnPlayerIndex = playerIndex;
    session.kdBuzzerOpen = false;
    io.emit('disable-answer-button-kd');
    io.emit('player-got-turn-kd', playerIndex);
  });

  safeOn(ctx, 'clear-turn-kd', () => {
    if (!isStaff(ctx)) return;
    log('Cleared turn khoi dong');
    session.kdTurnPlayerIndex = NO_PLAYER;
    session.kdBuzzerOpen = true;
    io.emit('clear-turn-player-kd');
    io.emit('enable-answer-button-kd');
  });

  safeOn(ctx, 'clear-turn-kd-f', () => {
    if (!isStaff(ctx)) return;
    session.kdTurnPlayerIndex = NO_PLAYER;
    session.kdBuzzerOpen = false;
    io.emit('clear-turn-player-kd');
  });

  safeOn(ctx, 'correct-mark-kd', () => {
    if (!isAdmin(ctx)) return;
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
    session.kdDecisionTimerOwner = DecisionTimerOwner.None;
    session.kdTurnPlayerIndex = NO_PLAYER;
  });

  safeOn(ctx, 'wrong-mark-kd', () => {
    if (!isAdmin(ctx)) return;
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
    session.kdDecisionTimerOwner = DecisionTimerOwner.None;
    session.kdTurnPlayerIndex = NO_PLAYER;
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
    session.kdDecisionRemaining = 0;
    session.kdBuzzerOpen = true;
    emitQuestionNumbers();
    io.emit('enable-answer-button-kd');
    io.emit('update-questions-number-kd', questionCount);
  });

  // Post-buzz decision window: rules.kdDecisionTicks × rules.decisionTickMs.
  // Expiry of either variant only plays the wrong cue; the admin marks the
  // answer or skips the question manually.
  safeOn(ctx, 'start-3s-timer-kd', (isPlayerTimer: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof isPlayerTimer !== 'boolean') return;
    if (session.kdDecisionCountdown !== undefined) clearInterval(session.kdDecisionCountdown);
    let counter = rules.kdDecisionTicks;
    session.kdDecisionRemaining = counter;
    session.kdDecisionTimerOwner = isPlayerTimer
      ? DecisionTimerOwner.Player
      : DecisionTimerOwner.Admin;
    io.emit('update-3s-timer-kd', counter, isPlayerTimer);

    const handle = setInterval(() => {
      counter -= 1;
      session.kdDecisionRemaining = Math.max(counter, 0);
      io.emit('update-3s-timer-kd', counter, isPlayerTimer);

      if (isPlayerTimer) {
        if (session.kdDecisionTimerOwner === DecisionTimerOwner.None) {
          clearInterval(handle);
          session.kdDecisionRemaining = 0;
          if (timer.remainingSeconds() > 0) {
            session.kdBuzzerOpen = true;
            io.emit('enable-answer-button-kd');
          }
          session.kdTurnPlayerIndex = NO_PLAYER;
          io.emit('update-3s-timer-kd', 0, true);
          io.emit('update-3s-timer-kd', 0, false);
        } else if (counter === 0) {
          clearInterval(handle);
          session.kdDecisionRemaining = 0;
          if (timer.remainingSeconds() > 0) {
            session.kdBuzzerOpen = true;
            io.emit('enable-answer-button-kd');
          }
          if (session.kdDecisionTimerOwner === DecisionTimerOwner.Player) {
            session.kdDecisionTimerOwner = DecisionTimerOwner.None;
            io.emit('update-match-data', store.getMatch());
            io.emit('play-sfx', SFX_WRONG);
            emitQuestionNumbers();
          }
        }
      } else {
        if (counter === 0) {
          clearInterval(handle);
          session.kdDecisionRemaining = 0;
          session.kdDecisionTimerOwner = DecisionTimerOwner.None;
          if (timer.remainingSeconds() > 0) {
            session.kdBuzzerOpen = true;
            io.emit('enable-answer-button-kd');
          }
          io.emit('play-sfx', SFX_WRONG);
          emitQuestionNumbers();
        } else if (session.kdDecisionTimerOwner !== DecisionTimerOwner.Admin) {
          clearInterval(handle);
          session.kdDecisionRemaining = 0;
          io.emit('update-3s-timer-kd', 0, false);
        }
      }
    }, rules.decisionTickMs);
    session.kdDecisionCountdown = handle;
  });

  safeOn(ctx, 'stop-3s-timer-kd', () => {
    if (!isStaff(ctx)) return;
    session.kdDecisionTimerOwner = DecisionTimerOwner.None;
    session.kdDecisionRemaining = 0;
  });
}
