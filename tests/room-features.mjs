import { io } from 'socket.io-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, roomsDir] = process.argv.slice(2);
const base = `http://localhost:${port}`;
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};
const call = async (path, { method = 'GET', token, body } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
};
const post = (path, body, token) => call(path, { method: 'POST', token, body });
const connect = (token) => new Promise((resolve) => {
  const socket = io(base, { auth: { token }, reconnection: false, timeout: 4000 });
  socket.on('connect', () => resolve({ socket, status: 'connected' }));
  socket.on('connect_error', (error) => { socket.close(); resolve({ socket, status: error.message }); });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const server = await call('/api/server');
check('hosted server info', server.status === 200 && server.body.multiRoom === true && server.body.version === JSON.parse(readFileSync('package.json')).version);
const empty = await call('/api/session');
check('hosted session requires room', empty.status === 404 && empty.body.error === 'Join a room first');
const host = (await post('/api/accounts', { username: `features${Date.now().toString(36)}`, password: 'password-123' })).body;
const room = (await post('/api/rooms', {}, host.token)).body;
const admin = room.token;
const session = await call('/api/session', { token: admin });
check('hosted session identity', session.status === 200 && session.body.roleId === 1 && session.body.roomId === room.roomId && !session.body.sessionId);
const joinRoom = (secret, username, token) => post('/api/rooms/join', { code: room.code, secret, username }, token);
const setMode = (spectatorMode) => call('/api/rooms/current/settings', { method: 'PATCH', token: admin, body: { spectatorMode } });
check('open spectators', (await joinRoom()).body.roleId === 3);
await setMode('secret');
const secretRequired = await joinRoom();
check('secret mode requires secret', secretRequired.status === 401 && secretRequired.body.error === 'This room needs a spectator secret');
const viewer = (await joinRoom(room.secrets.spectator)).body;
check('spectator secret grants viewer', viewer.roleId === 3);
await setMode('off');
check('off rejects secretless join', (await joinRoom()).status === 403);
check('off rejects spectator secret', (await joinRoom(room.secrets.spectator)).status === 403);
check('switching to off revokes existing non-link viewer', (await call('/api/session', { token: viewer.token })).status === 404);
await setMode('secret');
const viewer2 = (await joinRoom(room.secrets.spectator)).body;
const v1 = await connect(viewer2.token);
const v2 = await connect(viewer2.token);
const v3 = await connect(viewer2.token);
const adminSocket = await connect(admin);
check('viewer cap and admin exemption', v1.status === 'connected' && v2.status === 'connected' && v3.status === 'Room is full' && adminSocket.status === 'connected');
v1.socket.close();
v2.socket.close();
adminSocket.socket.close();
await sleep(100);
const rotated = await post('/api/rooms/current/secrets', { role: 'spectator' }, admin);
check('spectator rotation revokes viewer', rotated.status === 200 && rotated.body.spectator !== room.secrets.spectator && (await call('/api/session', { token: viewer2.token })).status === 404);
await setMode('off');
const makeLink = (body) => post('/api/rooms/current/links', body, admin);
const created = await makeLink({ role: 'viewer', view: 'stream', label: 'Stream' });
const link = created.body;
check('create link with fragment', created.status === 201 && link.path === `/r/${room.code}/stream#k=${link.token}` && !link.link.tokenHash);
const stored = JSON.parse(readFileSync(join(roomsDir, room.roomId, 'room.json'), 'utf8'));
check('raw token never stored', !JSON.stringify(stored).includes(link.token) && stored.links[0].tokenHash.length === 64);
const listed = await call('/api/rooms/current/links', { token: admin });
check('list hides hashes', listed.status === 200 && listed.body.some((item) => item.id === link.link.id && !item.tokenHash));
const linked = await post('/api/rooms/join-link', { token: link.token });
check('viewer link bypasses off', linked.status === 200 && linked.body.roleId === 3);
const linkedSocket = await connect(linked.body.token);
const deleted = await call(`/api/rooms/current/links/${link.link.id}`, { method: 'DELETE', token: admin });
await sleep(100);
check('delete revokes link session and socket', deleted.status === 204 && linkedSocket.socket.disconnected && (await call('/api/session', { token: linked.body.token })).status === 404 && (await post('/api/rooms/join-link', { token: link.token })).status === 401);
const once = (await makeLink({ role: 'mc', label: 'Once', singleUse: true })).body;
check('single use', (await post('/api/rooms/join-link', { token: once.token })).body.roleId === 2 && (await post('/api/rooms/join-link', { token: once.token })).status === 401);
const expiring = (await makeLink({ role: 'viewer', label: 'Expires', expiresInSeconds: 0.01 })).body;
await sleep(30);
check('expiry', (await post('/api/rooms/join-link', { token: expiring.token })).status === 401);
const badPlayerLink = await makeLink({ role: 'player', label: 'Player' });
check('player link requires playerIndex', badPlayerLink.status === 400);
const playerLink = (await makeLink({ role: 'player', playerIndex: 2, label: 'Player 3' })).body;
const player = await post('/api/rooms/join-link', { token: playerLink.token });
check('player link maps directly to seat', player.status === 200 && player.body.roleId === 0 && player.body.index === 2);
await call('/api/match/position', { method: 'PATCH', token: admin, body: { position: 'KD' } });
const lateJoin = await joinRoom(room.secrets.players[1]);
check('player can join with own code during match', lateJoin.status === 200 && lateJoin.body.index === 1);
const rotatedPlayer = await post('/api/rooms/current/secrets', { role: 'player', playerIndex: 1 }, admin);
check('rotating player secret revokes that player only', rotatedPlayer.status === 200 && rotatedPlayer.body.players[1] !== room.secrets.players[1] && (await call('/api/session', { token: lateJoin.body.token })).status === 404 && (await call('/api/session', { token: player.body.token })).status === 200);
const badRename = await call('/api/rooms/current/settings', { method: 'PATCH', token: admin, body: { name: '   ' } });
check('rejects blank room name', badRename.status === 400);
const renamedInRoom = await call('/api/rooms/current/settings', { method: 'PATCH', token: admin, body: { name: 'Chung kết năm' } });
const currentAfterRename = await call('/api/rooms/current', { token: admin });
const matchAfterRename = await call('/api/match', { token: admin });
check('rename room via settings', renamedInRoom.status === 200 && renamedInRoom.body.name === 'Chung kết năm' && currentAfterRename.body.name === 'Chung kết năm' && matchAfterRename.body.matchName === 'Chung kết năm');
const renamedByOwner = await call(`/api/rooms/${room.roomId}`, { method: 'PATCH', token: host.token, body: { name: 'Trận tuần 1' } });
const meAfterRename = await call('/api/accounts/me', { token: host.token });
const otherHost = (await post('/api/accounts', { username: `other${Date.now().toString(36)}`, password: 'password-123' })).body;
const foreignRename = await call(`/api/rooms/${room.roomId}`, { method: 'PATCH', token: otherHost.token, body: { name: 'Hijack' } });
check('rename room by owner', renamedByOwner.status === 200 && renamedByOwner.body.name === 'Trận tuần 1' && meAfterRename.body.rooms.some((r) => r.roomId === room.roomId && r.name === 'Trận tuần 1') && foreignRename.status === 404);
// Hosted-mode SPA deep links (share links and the host area) must load the
// client, never a JSON 404 — skipped when the Legion build is absent.
const legionIndex = join(process.cwd(), 'Legion', 'index.html');
let hasLegion = true;
try { readFileSync(legionIndex); } catch { hasLegion = false; }
if (hasLegion) {
  for (const path of [`/r/${room.code}`, `/r/${room.code}/stream`, '/host', '/host/auth']) {
    const html = await fetch(`${base}${path}`).then((r) => r.text());
    check(`SPA serves ${path}`, html.includes('<app-root'));
  }
} else {
  console.log('SKIP  SPA deep links (Legion build missing)');
}
process.exitCode = failures ? 1 : 0;
