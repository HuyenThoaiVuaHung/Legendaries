import { QuestionBankStore } from '../services/question-bank.store';
import type { ApiDeps } from '../http';

/** A separate account-authenticated namespace; game sockets never receive authoring data. */
export function registerBankSockets(deps: ApiDeps, bank: QuestionBankStore): void {
  const ns = deps.io.of('/bank');
  const counts = new Map<string, number>();
  const presence = (id: string): void => {
    const peers = [...ns.sockets.values()].filter((s) => s.data.setId === id && s.connected)
      .map((s) => ({ username: String(s.data.username), tabId: String(s.data.tabId) }));
    ns.to(id).emit('presence', peers);
  };
  deps.auth.sessions.onRevoke((revoked) => {
    for (const socket of ns.sockets.values()) {
      const sessionId = socket.data.sessionId;
      if (typeof sessionId === 'string' && revoked.has(sessionId)) {
        socket.emit('access-revoked');
        socket.disconnect(true);
      }
    }
  });
  bank.onChange = (id) => {
    for (const socket of ns.sockets.values()) if (socket.data.setId === id) {
      try { bank.access(id, String(socket.data.accountId)); }
      catch { socket.emit('access-revoked'); socket.disconnect(true); }
    }
    ns.to(id).emit('changed');
  };
  ns.use((socket, next) => {
    try {
      const token: unknown = socket.handshake.auth?.token;
      const id: unknown = socket.handshake.auth?.setId;
      const tabId: unknown = socket.handshake.auth?.tabId;
      if (typeof token !== 'string' || typeof id !== 'string' || typeof tabId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tabId)) throw new Error('Sign in to collaborate');
      const identity = deps.auth.verifyAccount(token);
      if (!identity) throw new Error('Sign in to collaborate');
      const account = deps.accounts.get(identity.accountId);
      if (!account) throw new Error('Account not found');
      bank.access(id, account.id);
      if ((counts.get(account.id) ?? 0) >= 10) throw new Error('Too many editing tabs');
      socket.data.sessionId = identity.sessionId;
      socket.data.accountId = account.id;
      socket.data.username = account.username;
      socket.data.setId = id;
      socket.data.tabId = tabId;
      next();
    } catch (error) { next(error instanceof Error ? error : new Error('Cannot join set')); }
  });
  ns.on('connection', (socket) => {
    const accountId = String(socket.data.accountId);
    const sessionId = String(socket.data.sessionId);
    const id = String(socket.data.setId);
    if ((counts.get(accountId) ?? 0) >= 10) { socket.disconnect(true); return; }
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
    void socket.join(id);
    presence(id);
    socket.emit('changed');
    const check = setInterval(() => {
      try {
        if (!deps.auth.sessions.isAlive(sessionId)) throw new Error('Session expired');
        bank.access(id, accountId);
        socket.emit('changed'); // Also refresh expired leases and presence after reconnects.
      } catch { socket.emit('access-revoked'); socket.disconnect(true); }
    }, 10000);
    check.unref();
    socket.once('disconnect', () => {
      clearInterval(check);
      const count = (counts.get(accountId) ?? 1) - 1;
      if (count) counts.set(accountId, count); else counts.delete(accountId);
      presence(id);
    });
  });
}
