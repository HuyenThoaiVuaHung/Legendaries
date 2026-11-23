import { Server } from 'socket.io';
import { RoomLink, RoomSecrets, SpectatorMode } from '../contracts/api';
import { GameRules } from '../game.rules';
import { LegionFileService } from '../services/legion-file.service';
import { MediaStore } from '../services/media.store';
import { UiConfigStore } from '../services/ui-config.store';
import { TimerService } from '../services/timer.service';
import { GameSessionState } from '../state/game.state';
import { MatchStore } from '../state/match.store';

/**
 * Where a room broadcasts. `io.to(roomId)` satisfies it, so every existing
 * `io.emit(...)` in the handlers reaches only that room's sockets.
 */
export interface RoomChannel {
  emit(event: string, ...args: unknown[]): boolean;
}

/** Persisted identity of a created room (`<roomsDir>/<id>/room.json`). */
export interface RoomMeta {
  code: string;
  /** Host account that owns the room (created it, or received it). */
  ownerAccountId: string;
  secrets: RoomSecrets;
  spectatorMode: SpectatorMode;
  /** Shown in the public room list (GET /api/rooms/public). */
  listed: boolean;
  links: (RoomLink & { tokenHash: string })[];
  /** The room's live rules; persisted so settings survive a restart. */
  rules: GameRules;
  createdAt: number;
  lastActiveAt: number;
}

/** Everything one match owns. One instance per room. */
export class Room {
  readonly channel: RoomChannel;
  readonly staffChannel: RoomChannel;
  readonly publicChannel: RoomChannel;
  readonly session = new GameSessionState();
  readonly timer: TimerService;
  readonly legionFiles: LegionFileService;

  constructor(
    readonly id: string,
    io: Server,
    readonly store: MatchStore,
    readonly media: MediaStore,
    readonly rules: GameRules,
    readonly ui: UiConfigStore,
    /** Absent for the default room, whose secrets live in server config. */
    readonly meta?: RoomMeta,
  ) {
    this.channel = io.to(id);
    this.staffChannel = io.to(`${id}:staff`);
    this.publicChannel = io.to(`${id}:public`);
    this.timer = new TimerService(this.channel, store, rules, () => {
      this.session.kdBuzzerOpen = false;
      this.session.chpBuzzerOpen = false;
    });
    this.legionFiles = new LegionFileService(store, media, ui);
  }

  /** Record activity for a created room. */
  touch(): void {
    if (this.meta) this.meta.lastActiveAt = Date.now();
  }

  /** Earliest idle or maximum lifetime deadline. */
  expiresAt(idleMs: number, maxMs: number): number | null {
    if (!this.meta) return null;
    return Math.min(this.meta.lastActiveAt + idleMs, this.meta.createdAt + maxMs);
  }

  /** Remaining media storage; the default room and zero quota are unlimited. */
  quotaRemaining(quotaBytes: number): number {
    if (!this.meta || quotaBytes === 0) return Infinity;
    return Math.max(0, quotaBytes - this.media.usageBytes());
  }

  /** Stop every timer the room owns, silently; used when closing it. */
  dispose(): void {
    this.timer.dispose();
    this.session.clearTimers();
  }
}
