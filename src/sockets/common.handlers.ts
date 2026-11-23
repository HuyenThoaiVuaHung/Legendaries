import { VideoControlAction, VideoControlCommand, VideoStateUpdate, VideoTarget } from '../contracts/game';
import { buildLiveStateSnapshot, emitRoundUpdate } from '../services/round-view';
import { clockRoundOf, TIMED_SFX_DURATIONS_MS } from '../time/clock.policies';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

const MS_PER_SECOND = 1000;
const VIDEO_TARGETS: readonly VideoTarget[] = ['tt', 'vd'];
const VIDEO_ACTIONS: readonly VideoControlAction[] = [
  'play',
  'pause',
  'toggle',
  'restart',
  'seek',
  'volume',
  'mute',
  'fullscreen',
];

/**
 * Match-wide realtime events that belong to no single round: starting the
 * match, driving the main clock, relaying sound effects, and live-state sync.
 */
export function registerCommonHandlers(ctx: HandlerContext): void {
  const { io, room, socket, identity, store, session, timers } = ctx;

  safeOn(ctx, 'request-live-state', () => {
    socket.emit('live-state', buildLiveStateSnapshot(room, identity.roleId));
  });

  safeOn(ctx, 'beginMatch', () => {
    if (!isAdmin(ctx)) return;
    store.updateMatch((match) => {
      match.position = 'KD';
    });
    socket.to(room.id).emit('beginMatch');
  });

  // Atomic: the server picks the real start instant, starts the clock, and
  // schedules the round's countdown SFX (and the TT start stamp) against it.
  safeOn(ctx, 'start-clock', (seconds: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return;
    // Multiplayer KD opens the buzzer itself, per question.
    if (!room.kdFlow.isMultiplayer()) {
      session.kdBuzzerOpen = true;
      io.emit('enable-answer-button-kd');
    }
    const position = store.getMatch().position;
    const startsAtMono = timers.startMain(seconds, timers.startDelayFor(position));
    const startsAt = room.time.epoch(startsAtMono);

    const code = timers.sfxCodeFor(position, seconds);
    if (code) {
      session.activeTimedSfx = { code, loop: false, startedAt: startsAt, durationMs: seconds * MS_PER_SECOND };
      timers.playSfxAt(code, startsAtMono);
    }
    if (clockRoundOf(position) === 'TT') {
      const data = store.round('tt').update((d) => {
        d.timerStartTimestamp = startsAt;
      });
      emitRoundUpdate(room, 'tt', data);
    }
  });

  safeOn(ctx, 'play-pause-clock', () => {
    if (!isStaff(ctx)) return;
    timers.togglePause();
  });

  safeOn(ctx, 'time-sync', (_clientSentAt: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    ack(room.time.epoch());
  });

  safeOn(ctx, 'play-sfx', (sfx: unknown, loop?: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof sfx !== 'string' || sfx.length === 0 || sfx.length > 100) return;
    const isLoop = loop === true;
    const timed = TIMED_SFX_DURATIONS_MS[sfx] !== undefined;
    if (!isLoop && timed && timers.isDuplicateClientSfx(sfx)) return;
    const now = Date.now();
    if (isLoop) {
      session.activeLoopSfx = { code: sfx, loop: true, startedAt: now };
    } else if (timed) {
      session.activeTimedSfx = {
        code: sfx,
        loop: false,
        startedAt: now,
        durationMs: TIMED_SFX_DURATIONS_MS[sfx],
      };
    }
    io.emit('play-sfx', sfx, typeof loop === 'boolean' ? loop : undefined);
  });

  safeOn(ctx, 'video-control', (raw: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof raw !== 'object' || raw === null) return;
    const { target, action, value } = raw as Partial<VideoControlCommand>;
    if (!target || !VIDEO_TARGETS.includes(target)) return;
    if (!action || !VIDEO_ACTIONS.includes(action)) return;
    const now = Date.now();
    const state = session.applyVideoControl(target, { target, action, value }, now);
    const update: VideoStateUpdate = { target, state, serverTime: now };
    io.emit('video-state', update);
  });
}
