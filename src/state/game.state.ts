import {
  ActiveAudioState,
  ChpQuestion,
  KdQuestion,
  VdQuestion,
  VideoControlCommand,
  VideoPlaybackState,
  VideoTarget,
} from '../contracts/game';
import { PLAYER_COUNT } from '../game.rules';

export const NO_PLAYER = -1;

function createVideoState(muted: boolean): VideoPlaybackState {
  return {
    playing: false,
    startedAt: null,
    positionSec: 0,
    volume: 1,
    muted,
    fullscreen: false,
  };
}

/** Which kind of post-buzz decision timer is running. */
export enum DecisionTimerOwner {
  None = 'none',
  Admin = 'admin',
  Player = 'player',
}

/**
 * Ephemeral per-match session state: everything that lives only while the
 * server runs and is never persisted. One instance per room.
 */
export class GameSessionState {
  /** socket.id per player index; '' when that player is not connected. */
  readonly playerSocketIds: string[] = Array(PLAYER_COUNT).fill('');

  /** Active looping SFX (e.g. KD_60S) and timed countdown track (e.g. TT_30S). */
  activeLoopSfx: ActiveAudioState | null = null;
  activeTimedSfx: ActiveAudioState | null = null;

  /** KD: player index currently holding the buzzer turn. */
  kdTurnPlayerIndex = NO_PLAYER;
  kdBuzzerOpen = false;
  kdDecisionTimerOwner = DecisionTimerOwner.None;
  kdDecisionRemaining = 0;
  kdMaxQuestionCount = 0;
  kdCurrentQuestionNo = 0;
  /** KD: question currently on screen and the previous question's answer. */
  kdCurrentQuestion: KdQuestion | null = null;
  kdPreviousAnswer: string | null = null;
  /** KD: handle of the running post-buzz decision countdown, if any. */
  kdDecisionCountdown?: NodeJS.Timeout;

  /** VCNV: currently broadcast/highlighted 1-based row id, if any. */
  vcnvCurrentQuestionId: number | null = null;
  vcnvHighlightedQuestionId: number | null = null;

  /** TT: video playback state for video questions (muted by default). */
  ttVideo: VideoPlaybackState = createVideoState(true);

  /** VD: player index that pressed the steal button. */
  vdStealingPlayerIndex = NO_PLAYER;
  vdStealWindowOpen = false;
  vdStealRemaining = 0;
  vdHopeStarPenalized = false;
  /** VD: the question currently on screen, set by 'broadcast-vd-question'. */
  vdCurrentQuestion?: VdQuestion;
  vdVideo: VideoPlaybackState = createVideoState(false);
  /** VD: handle of the running steal-window countdown, if any. */
  vdStealCountdown?: NodeJS.Timeout;

  /** CHP: player index holding the tiebreak turn. */
  chpTurnPlayerIndex = NO_PLAYER;
  chpBuzzerOpen = false;
  chpCurrentQuestion: ChpQuestion | null = null;
  chpPlayedPlayers: boolean[] = Array(PLAYER_COUNT).fill(false);

  videoOf(target: VideoTarget): VideoPlaybackState {
    return target === 'tt' ? this.ttVideo : this.vdVideo;
  }

  /** Reset playback & fullscreen when switching questions or rounds; keeps volume/mute. */
  resetVideoPlayback(target: VideoTarget): VideoPlaybackState {
    const v = this.videoOf(target);
    v.playing = false;
    v.startedAt = null;
    v.positionSec = 0;
    v.fullscreen = false;
    return { ...v };
  }

  applyVideoControl(target: VideoTarget, cmd: VideoControlCommand, now = Date.now()): VideoPlaybackState {
    const v = this.videoOf(target);
    const currentPos = () =>
      v.playing && v.startedAt !== null
        ? v.positionSec + Math.max(0, (now - v.startedAt) / 1000)
        : v.positionSec;

    switch (cmd.action) {
      case 'play':
        if (!v.playing) {
          v.playing = true;
          v.startedAt = now;
        }
        break;
      case 'pause':
        if (v.playing) {
          v.positionSec = currentPos();
          v.playing = false;
          v.startedAt = null;
        }
        break;
      case 'toggle':
        if (v.playing) {
          v.positionSec = currentPos();
          v.playing = false;
          v.startedAt = null;
        } else {
          v.playing = true;
          v.startedAt = now;
        }
        break;
      case 'restart':
        v.positionSec = 0;
        v.playing = true;
        v.startedAt = now;
        break;
      case 'seek':
        if (typeof cmd.value === 'number' && Number.isFinite(cmd.value) && cmd.value >= 0) {
          v.positionSec = cmd.value;
          if (v.playing) v.startedAt = now;
        }
        break;
      case 'volume':
        if (typeof cmd.value === 'number' && Number.isFinite(cmd.value)) {
          v.volume = Math.min(1, Math.max(0, cmd.value));
          if (v.volume > 0 && v.muted) v.muted = false;
        }
        break;
      case 'mute':
        v.muted = typeof cmd.value === 'boolean' ? cmd.value : !v.muted;
        break;
      case 'fullscreen':
        v.fullscreen = typeof cmd.value === 'boolean' ? cmd.value : !v.fullscreen;
        break;
    }
    return { ...v };
  }

  /** Stop every countdown this session owns, without emitting anything. */
  clearTimers(): void {
    if (this.kdDecisionCountdown !== undefined) clearInterval(this.kdDecisionCountdown);
    if (this.vdStealCountdown !== undefined) clearInterval(this.vdStealCountdown);
    this.kdDecisionCountdown = undefined;
    this.vdStealCountdown = undefined;
    this.kdDecisionRemaining = 0;
    this.vdStealRemaining = 0;
  }

  playerIndexOf(socketId: string): number {
    return this.playerSocketIds.indexOf(socketId);
  }

  isPlayer(socketId: string): boolean {
    return this.playerIndexOf(socketId) !== NO_PLAYER;
  }
}
