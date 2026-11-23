import { Socket } from 'socket.io';
import { Role } from '../contracts/api';
import { GameRules } from '../game.rules';
import { LogFn, LogLevel } from '../logger';
import { GameSessionState } from '../state/game.state';
import { MatchStore } from '../state/match.store';
import { TimerService } from '../services/timer.service';
import type { Room, RoomChannel } from '../rooms/room';

/** Set on every socket by the auth handshake middleware in sockets/index.ts. */
export interface SocketIdentity {
  roleId: Role;
  /** Player index (0-based); only for Role.Player. */
  index?: number;
  /** Room this socket joined; absent means the default room. */
  roomId?: string;
  /** Session behind the token, so revoking it can drop this socket. */
  sessionId?: string;
}

/**
 * Everything a round handler module may touch. Handlers never import fs,
 * never persist except through `store`, and never track their own timers.
 */
export interface HandlerContext {
  /** The socket's room: `io.emit` here reaches only that room. */
  io: RoomChannel;
  room: Room;
  socket: Socket;
  identity: SocketIdentity;
  store: MatchStore;
  session: GameSessionState;
  timer: TimerService;
  rules: GameRules;
  log: LogFn;
  isSessionAlive: () => boolean;
}

/** A round module's entry point: attach this socket's event listeners. */
export type HandlerRegistrar = (ctx: HandlerContext) => void;

export function isAdmin(ctx: HandlerContext): boolean {
  return ctx.identity.roleId === Role.Admin;
}

export function isStaff(ctx: HandlerContext): boolean {
  return ctx.identity.roleId === Role.Admin || ctx.identity.roleId === Role.Mc;
}

/**
 * Attach a socket event listener guarded by session liveness and a boundary
 * exception catch so malformed client payloads never crash the process.
 */
export function safeOn(
  ctx: HandlerContext,
  event: string,
  handler: (...args: unknown[]) => void,
): void {
  ctx.socket.on(event, (...args: unknown[]) => {
    if (!ctx.isSessionAlive()) {
      ctx.socket.disconnect(true);
      return;
    }
    try {
      handler(...args);
    } catch (err) {
      ctx.log(`Socket handler "${event}" failed for ${ctx.socket.id}: ${String(err)}`, LogLevel.Warn);
    }
  });
}
