import { Role } from '../contracts/api';
import { PLAYER_COUNT } from '../game.rules';
import { emitRoundUpdate, sanitizeChpQuestion } from '../services/round-view';
import { NO_PLAYER } from '../state/game.state';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

// Sound-effect identifiers understood by the frontend (protocol vocabulary,
// names kept from the old client). CHP reuses the KD buzz and VD verdict cues.
const SFX_GET_TURN = 'KD_GET_TURN';
const SFX_CORRECT = 'VD_CORRECT';
const SFX_WRONG = 'VD_WRONG';

/** Player index of the acting socket, or NO_PLAYER when it isn't a player. */
function resolvePlayerIndex(ctx: HandlerContext): number {
  if (ctx.identity.roleId === Role.Player && ctx.identity.index !== undefined) {
    return ctx.identity.index;
  }
  return ctx.session.playerIndexOf(ctx.socket.id);
}

export function registerChpHandlers(ctx: HandlerContext): void {
  const { io, room, socket, store, session, timers, rules } = ctx;
  const chp = store.round('chp');

  safeOn(ctx, 'broadcast-chp-question', (id: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) return;
    const data = chp.update((d) => {
      d.playedPlayers = Array(PLAYER_COUNT).fill(false);
    });
    session.chpTurnPlayerIndex = NO_PLAYER;
    const q = data.questions[id];
    session.chpCurrentQuestion = q ?? null;
    if (!q) {
      io.emit('update-chp-question', {});
      return;
    }
    room.staffChannel.emit('update-chp-question', q);
    room.publicChannel.emit('update-chp-question', sanitizeChpQuestion(q));
  });

  safeOn(ctx, 'start-timer-chp', () => {
    if (!isStaff(ctx)) return;
    session.chpBuzzerOpen = true;
    timers.startMain(rules.chpTurnSeconds, rules.clockStartDelayMs.CHP);
    io.emit('unlock-button-chp');
  });

  safeOn(ctx, 'get-turn-chp', () => {
    if (!session.chpBuzzerOpen || !timers.main.isRunning()) return;
    if (session.chpTurnPlayerIndex !== NO_PLAYER) return;
    const playerIndex = resolvePlayerIndex(ctx);
    if (playerIndex === NO_PLAYER) return;
    if (chp.get().playedPlayers[playerIndex]) return;

    session.chpTurnPlayerIndex = playerIndex;
    session.chpBuzzerOpen = false;
    io.emit('lock-button-chp');
    io.emit('play-sfx', SFX_GET_TURN);
    io.emit('got-turn-chp', playerIndex);
    timers.togglePause();
  });

  safeOn(ctx, 'mark-correct-chp', () => {
    if (!isAdmin(ctx)) return;
    const holder = session.chpTurnPlayerIndex;
    if (holder === NO_PLAYER) return;

    io.emit('play-sfx', SFX_CORRECT);
    const match = store.updateMatch((m) => {
      if (m.players[holder]) m.players[holder].score += rules.chpCorrectPoints;
    });
    io.emit('update-match-data', match);
    session.chpTurnPlayerIndex = NO_PLAYER;
    io.emit('clear-turn-chp');
  });

  safeOn(ctx, 'mark-wrong-chp', () => {
    if (!isAdmin(ctx)) return;
    const holder = session.chpTurnPlayerIndex;
    if (holder === NO_PLAYER) return;

    timers.togglePause();
    io.emit('play-sfx', SFX_WRONG);
    session.chpBuzzerOpen = true;
    io.emit('unlock-button-chp');
    const holderSocketId = session.playerSocketIds[holder];
    if (holderSocketId) socket.nsp.to(holderSocketId).emit('lock-button-chp');
    chp.update((d) => {
      d.playedPlayers[holder] = true;
    });
    session.chpTurnPlayerIndex = NO_PLAYER;
    io.emit('clear-turn-chp');
  });

  safeOn(ctx, 'clear-turn-chp', () => {
    if (!isAdmin(ctx)) return;
    const data = chp.update((d) => {
      d.playedPlayers = Array(PLAYER_COUNT).fill(false);
    });
    session.chpTurnPlayerIndex = NO_PLAYER;
    session.chpBuzzerOpen = true;
    emitRoundUpdate(room, 'chp', data);
    io.emit('unlock-button-chp');
    io.emit('clear-turn-chp');
  });

  safeOn(ctx, 'clear-question-chp', () => {
    if (!isStaff(ctx)) return;
    session.chpCurrentQuestion = null;
    session.chpTurnPlayerIndex = NO_PLAYER;
    io.emit('update-chp-question', {});
  });
}
