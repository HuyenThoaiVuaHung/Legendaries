import { Role } from '../contracts/api';
import { emitRoundUpdate, sanitizeVdQuestion } from '../services/round-view';
import { NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

/** Protocol sentinel the admin client sends to clear the current question. */
const CLEAR_QUESTION_ID = -1;

/** Player index of the acting socket, or NO_PLAYER when it isn't a player. */
function resolvePlayerIndex(ctx: HandlerContext): number {
  if (ctx.identity.roleId === Role.Player && ctx.identity.index !== undefined) {
    return ctx.identity.index;
  }
  return ctx.session.playerIndexOf(ctx.socket.id);
}

export function registerVdHandlers(ctx: HandlerContext): void {
  const { io, room, store, session, log, rules } = ctx;
  const vd = store.round('vd');

  safeOn(ctx, 'broadcast-vd-question', (id: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof id !== 'number' || !Number.isInteger(id)) return;
    session.vdHopeStarPenalized = false;
    session.vdStealWindowOpen = false;
    session.vdStealRemaining = 0;
    session.vdStealingPlayerIndex = NO_PLAYER;
    const resetVideo = session.resetVideoPlayback('vd');
    io.emit('video-state', { target: 'vd', state: resetVideo, serverTime: Date.now() });
    if (id === CLEAR_QUESTION_ID) {
      session.vdCurrentQuestion = undefined;
      io.emit('update-vedich-question', undefined);
      if (vd.get().hopeStarActive) {
        const data = vd.update((d) => {
          d.hopeStarActive = false;
        });
        emitRoundUpdate(room, 'vd', data);
      }
      return;
    }
    const data = vd.get();
    const q = data.questionPools[data.activePlayerIndex]?.[id];
    session.vdCurrentQuestion = q;
    if (!q) {
      io.emit('update-vedich-question', undefined);
      return;
    }
    room.staffChannel.emit('update-vedich-question', q);
    room.publicChannel.emit('update-vedich-question', sanitizeVdQuestion(q));
  });

  safeOn(ctx, 'mark-correct-vd', (playerIndex: unknown, value: unknown) => {
    if (!isAdmin(ctx)) return;
    if (typeof playerIndex !== 'number' || !Number.isInteger(playerIndex)) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const data = vd.get();
    const stealerIndex = session.vdStealingPlayerIndex;

    const match = store.updateMatch((m) => {
      const player = m.players[playerIndex];
      if (!player) return;
      if (data.hopeStarActive && stealerIndex === NO_PLAYER) {
        const gained = value * rules.vdHopeStarMultiplier;
        player.score += gained;
        log(`Player ${player.name} got ${gained} points`);
      } else if (stealerIndex !== NO_PLAYER) {
        player.score += value;
        log(`Player ${player.name} got ${value} points`);
        if (!data.hopeStarActive) {
          const owner = m.players[data.activePlayerIndex];
          if (owner) {
            const lost = Math.min(value, Math.max(owner.score, 0));
            owner.score -= lost;
            log(`Player ${owner.name} lost ${lost} points`);
          }
        }
      } else {
        player.score += value;
        log(`Player ${player.name} got ${value} points`);
      }
    });

    const updated = vd.update((d) => {
      d.hopeStarActive = false;
    });
    session.vdStealingPlayerIndex = NO_PLAYER;
    session.vdStealWindowOpen = false;
    session.vdHopeStarPenalized = false;
    emitRoundUpdate(room, 'vd', updated);
    io.emit('update-match-data', match);
    io.emit('clear-stealing-player');
  });

  safeOn(ctx, 'mark-incorrect-vd', (playerIndex: unknown, value: unknown) => {
    if (!isAdmin(ctx)) return;
    if (typeof playerIndex !== 'number' || !Number.isInteger(playerIndex)) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;

    const match = store.updateMatch((m) => {
      const player = m.players[playerIndex];
      if (!player) return;
      const lost = value / rules.vdWrongPenaltyDivisor;
      const deducted = Math.min(lost, Math.max(player.score, 0));
      player.score -= deducted;
      log(`Player ${player.name} lost ${deducted} points`);
    });

    const updated = vd.update((d) => {
      d.hopeStarActive = false;
    });
    session.vdStealingPlayerIndex = NO_PLAYER;
    session.vdStealWindowOpen = false;
    session.vdHopeStarPenalized = false;
    emitRoundUpdate(room, 'vd', updated);
    io.emit('update-match-data', match);
    io.emit('clear-stealing-player');
  });

  safeOn(ctx, 'player-steal-question', () => {
    if (!session.vdStealWindowOpen) return;
    if (session.vdStealingPlayerIndex !== NO_PLAYER) return;
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER) return;
    if (playerIndex === vd.get().activePlayerIndex) return;
    io.emit('lock-button-vd');
    session.vdStealingPlayerIndex = playerIndex;
    session.vdStealWindowOpen = false;
    io.emit('player-steal-question', playerIndex);
  });

  safeOn(ctx, 'reset-stealing-player', () => {
    if (!isAdmin(ctx)) return;
    session.vdStealingPlayerIndex = NO_PLAYER;
    io.emit('clear-stealing-player');
  });

  safeOn(ctx, 'vd-play-video', () => {
    if (!isStaff(ctx)) return;
    const now = Date.now();
    const state = session.applyVideoControl('vd', { target: 'vd', action: 'toggle' }, now);
    io.emit('video-state', { target: 'vd', state, serverTime: now });
    io.emit('vd-play-video');
  });

  safeOn(ctx, 'start-5s-countdown-vd', () => {
    if (!isStaff(ctx)) return;
    let counter = rules.vdStealTicks;
    session.vdStealRemaining = counter;
    session.vdStealWindowOpen = true;
    io.emit('unlock-button-vd');

    const data = vd.get();
    if (data.hopeStarActive && session.vdCurrentQuestion !== undefined && !session.vdHopeStarPenalized) {
      session.vdHopeStarPenalized = true;
      const staked = session.vdCurrentQuestion.value;
      const match = store.updateMatch((m) => {
        const owner = m.players[data.activePlayerIndex];
        if (!owner) return;
        owner.score -= staked;
        log(`Player ${owner.name} lost ${staked} points`);
      });
      emitRoundUpdate(room, 'vd', data);
      io.emit('update-match-data', match);
    }

    io.emit('update-5s-countdown-vd', counter);
    if (session.vdStealCountdown !== undefined) clearInterval(session.vdStealCountdown);
    const handle = setInterval(() => {
      counter -= 1;
      session.vdStealRemaining = Math.max(counter, 0);
      io.emit('update-5s-countdown-vd', counter);
      if (counter <= 0 || !session.vdStealWindowOpen) {
        clearInterval(handle);
        if (session.vdStealCountdown === handle) session.vdStealCountdown = undefined;
        session.vdStealWindowOpen = false;
        session.vdStealRemaining = 0;
        io.emit('update-5s-countdown-vd', 0);
        io.emit('lock-button-vd');
      }
    }, rules.decisionTickMs);
    session.vdStealCountdown = handle;
  });
}
