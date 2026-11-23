/**
 * Smoke test for the rewritten Legendary server.
 * Boots nothing itself — expects the server on http://localhost:<PORT>.
 * Run: node tests/smoke.mjs [port]
 */
import { io } from 'socket.io-client';

const port = process.argv[2] ?? '8080';
const base = `http://localhost:${port}`;
let failures = 0;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const json = async (path, opts = {}) => {
  const res = await fetch(base + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// --- REST: auth ---------------------------------------------------------
const viewer = await json('/api/auth/login', { method: 'POST', body: '{}' });
check('viewer login', viewer.status === 200 && viewer.body?.roleId === 3, JSON.stringify(viewer));

const admin = await json('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ secret: 'BTC' }),
});
check('admin login', admin.status === 200 && admin.body?.roleId === 1 && admin.body?.token, JSON.stringify(admin));
const adminAuth = { authorization: `Bearer ${admin.body?.token}` };

const player = await json('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ secret: '123' }),
});
check('player login', player.body?.roleId === 0 && player.body?.index === 0, JSON.stringify(player));

// --- REST: match + rounds ----------------------------------------------
const match = await json('/api/match', { headers: adminAuth });
check('get match', match.status === 200 && Array.isArray(match.body?.players) && match.body?.roundFiles?.kd !== undefined, JSON.stringify(match.body)?.slice(0, 120));

const posDenied = await json('/api/match/position', { method: 'PATCH', body: JSON.stringify({ position: 'KD' }) });
check('position without token denied', posDenied.status === 401, `status ${posDenied.status}`);

const pos = await json('/api/match/position', {
  method: 'PATCH',
  headers: adminAuth,
  body: JSON.stringify({ position: 'KD' }),
});
check('admin sets position', pos.status === 200, JSON.stringify(pos.body));

for (const kind of ['kd', 'vcnv', 'tt', 'vd', 'chp']) {
  const r = await json(`/api/rounds/${kind}`, { headers: adminAuth });
  check(`get round ${kind}`, r.status === 200 && r.body !== null, `status ${r.status}`);
}

const kdViewer = await json('/api/rounds/kd', {
  headers: { authorization: `Bearer ${viewer.body?.token}` },
});
check('viewer kd round has questions stripped', kdViewer.status === 200 && kdViewer.body?.questions == null, JSON.stringify(kdViewer.body)?.slice(0, 120));

// --- Socket: handshake + realtime push -----------------------------------
await new Promise((resolve) => {
  const socket = io(base, { auth: { token: player.body?.token }, transports: ['websocket'] });
  const timeout = setTimeout(() => {
    check('socket connect (player token)', false, 'timeout');
    socket.close();
    resolve();
  }, 4000);

  socket.on('connect', () => {
    let gotMatchUpdate = false;
    socket.on('update-match-data', (m) => {
      if (gotMatchUpdate) return;
      gotMatchUpdate = true;
      check('player connect triggers update-match-data with isReady', m?.players?.[0]?.isReady === true, JSON.stringify(m?.players?.[0]));
      clearTimeout(timeout);
      socket.close();
      resolve();
    });
    check('socket connect (player token)', true);
    // Admin PATCH triggers a push we should also receive; isReady push happens on connect.
  });
  socket.on('connect_error', (e) => {
    check('socket connect (player token)', false, String(e));
    clearTimeout(timeout);
    resolve();
  });
});

// --- Media 404 sanity ----------------------------------------------------
const media404 = await fetch(`${base}/media/tt/definitely-not-a-file.png`);
check('missing media 404s', media404.status === 404, `status ${media404.status}`);

const serverInfo = await json('/api/server');
check('single venue server info', serverInfo.status === 200 && serverInfo.body.multiRoom === false && typeof serverInfo.body.version === 'string');
const viewerSession = await json('/api/session');
check('single venue viewer session', viewerSession.status === 200 && viewerSession.body.roleId === 3);
const adminSession = await json('/api/session', { headers: { authorization: `Bearer ${admin.body.token}` } });
check('single venue admin session', adminSession.status === 200 && adminSession.body.roleId === 1);

// --- Socket: clock protocol ---------------------------------------------
const adminSock = io(base, { auth: { token: admin.body?.token }, transports: ['websocket'] });
const playerSock = io(base, { auth: { token: player.body?.token }, transports: ['websocket'] });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await Promise.all([adminSock, playerSock].map((s) => new Promise((resolve) => s.once('connect', resolve))));
const clockViews = [];
const sfxPlays = [];
let ttRound = null;
adminSock.on('clock-state', (view) => { if (view.id === 'main') clockViews.push(view); });
adminSock.on('play-sfx', (code) => sfxPlays.push(code));
adminSock.on('update-tangtoc-data', (data) => { ttRound = data; });

const syncAck = await new Promise((resolve) => {
  const sentAt = Date.now();
  adminSock.timeout(2000).emit('time-sync', sentAt, (err, serverNow) => resolve(err ? null : serverNow));
});
check('time-sync ack returns server epoch', typeof syncAck === 'number' && Math.abs(syncAck - Date.now()) < 5000, String(syncAck));

await json('/api/match/position', { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ position: 'TT_Q' }) });
const ttData = await json('/api/rounds/tt', { headers: adminAuth });
if (ttData.body?.questions?.length) adminSock.emit('broadcast-tt-question', ttData.body.questions[0].id);
await wait(150);

adminSock.emit('start-clock', 10);
adminSock.emit('play-sfx', 'TT_10S');
await wait(60);
check('start-clock emits pending clock-state', clockViews.at(-1)?.status === 'pending' && clockViews.at(-1).durationMs === 10000, JSON.stringify(clockViews.at(-1)));
await wait(1100);
check('clock-state turns running after delay', clockViews.at(-1)?.status === 'running');
check('TT start sets timerStartTimestamp to clock startsAt', ttRound?.timerStartTimestamp === clockViews[0]?.startsAt, `${ttRound?.timerStartTimestamp} vs ${clockViews[0]?.startsAt}`);
await wait(100);
check('TT_10S plays exactly once despite client relay', sfxPlays.filter((c) => c === 'TT_10S').length === 1, JSON.stringify(sfxPlays));
adminSock.emit('play-pause-clock');
await wait(100);
const paused = clockViews.at(-1);
check('pause reports paused with exact remainder', paused?.status === 'paused' && paused.remainingMs > 0 && paused.remainingMs < paused.durationMs, JSON.stringify(paused));
adminSock.emit('play-pause-clock');
await wait(100);
check('resume reports running', clockViews.at(-1)?.status === 'running');
const seqs = clockViews.map((v) => v.seq);
check('clock-state seq strictly increases', seqs.length >= 4 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), JSON.stringify(seqs));
adminSock.emit('start-clock', 1);
await wait(2300);
check('clock expires', clockViews.at(-1)?.status === 'expired');

adminSock.emit('start-clock', 1);
await wait(2100);
playerSock.emit('player-submit-answer-tangtoc', 'LATE_BUT_GRACED');
await wait(150);
const graced = (await json('/api/rounds/tt', { headers: adminAuth })).body?.playerAnswers?.[0];
check('late TT answer inside grace window is accepted with elapsedMs', graced?.answer === 'LATE_BUT_GRACED' && typeof graced.elapsedMs === 'number', JSON.stringify(graced));
await wait(400);
playerSock.emit('player-submit-answer-tangtoc', 'TOO_LATE');
await wait(150);
const rejected = (await json('/api/rounds/tt', { headers: adminAuth })).body?.playerAnswers?.[0];
check('TT answer after grace window is rejected', rejected?.answer === 'LATE_BUT_GRACED', JSON.stringify(rejected));
adminSock.close();
playerSock.close();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
