import { VideoControlAction, VideoControlCommand, VideoStateUpdate, VideoTarget } from '../contracts/game';
import { buildLiveStateSnapshot } from '../services/round-view';
import { HandlerContext, isAdmin, isStaff, safeOn } from './context';

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

/** Nominal durations for timed countdown SFX so reconnecting clients can seek and resume. */
const TIMED_SFX_DURATIONS_MS: Readonly<Record<string, number>> = {
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

/**
 * Match-wide realtime events that belong to no single round: starting the
 * match, driving the main clock, relaying sound effects, and live-state sync.
 */
export function registerCommonHandlers(ctx: HandlerContext): void {
  const { io, room, socket, identity, store, session, timer, rules } = ctx;

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

  safeOn(ctx, 'start-clock', (seconds: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return;
    store.updateMatch((match) => {
      match.pausedTimerSeconds = 0;
    });
    session.kdBuzzerOpen = true;
    io.emit('enable-answer-button-kd');
    timer.startMainClock(seconds, { startDelayMs: rules.kdClockStartDelayMs });
  });

  safeOn(ctx, 'play-pause-clock', () => {
    if (!isStaff(ctx)) return;
    timer.togglePause();
  });

  safeOn(ctx, 'play-sfx', (sfx: unknown, loop?: unknown) => {
    if (!isStaff(ctx)) return;
    if (typeof sfx !== 'string' || sfx.length === 0 || sfx.length > 100) return;
    const isLoop = loop === true;
    const now = Date.now();
    if (isLoop) {
      session.activeLoopSfx = { code: sfx, loop: true, startedAt: now };
    } else if (TIMED_SFX_DURATIONS_MS[sfx] !== undefined) {
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
