/**
 * Security audit regression checks against a running hosted-mode server.
 * Run: node tests/security-audit.mjs <port>
 */
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import { join } from 'path';

const require = createRequire(join(process.cwd(), 'package.json'));
const { io } = require('socket.io-client');
const AdmZip = require('adm-zip');

const [port] = process.argv.slice(2);
const base = `http://localhost:${port}`;
let failures = 0;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (path, { token, method = 'GET', body, form } = {}) => {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
};

const connect = (auth) => new Promise((resolve) => {
  const s = io(base, { auth, reconnection: false, timeout: 4000, forceNew: true });
  s.once('connect', () => resolve({ s, status: 'connected' }));
  s.once('connect_error', (err) => { s.close(); resolve({ s, status: err.message }); });
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const uniq = randomBytes(4).toString('hex');
const host = (await call('/api/accounts', { method: 'POST', body: { username: `sec${uniq}`, password: 'sec-password-1' } })).body;
const roomA = (await call('/api/rooms', { method: 'POST', token: host.token })).body;
const roomB = (await call('/api/rooms', { method: 'POST', token: host.token })).body;
const viewerA = (await call('/api/rooms/join', { method: 'POST', body: { code: roomA.code } })).body;
const playerA0 = (await call('/api/rooms/join', { method: 'POST', body: { code: roomA.code, secret: roomA.secrets.players[0] } })).body;
const playerA1 = (await call('/api/rooms/join', { method: 'POST', body: { code: roomA.code, secret: roomA.secrets.players[1] } })).body;

const sockets = [];
try {
  // 1. High 1: Malformed handshake tokens & invalid obstacle index do not crash server
  const badObj = await connect({ token: { nope: true } });
  const badNum = await connect({ token: 12345 });
  check('malformed object token rejected without crash', badObj.status === 'Invalid token', badObj.status);
  check('malformed number token rejected without crash', badNum.status === 'Invalid token', badNum.status);

  const adminSockA = (await connect({ token: roomA.token })).s;
  const viewerSockA = (await connect({ token: viewerA.token })).s;
  const player0SockA = (await connect({ token: playerA0.token })).s;
  const player1SockA = (await connect({ token: playerA1.token })).s;
  const adminSockB = (await connect({ token: roomB.token })).s;
  sockets.push(adminSockA, viewerSockA, player0SockA, player1SockA, adminSockB);

  adminSockA.emit('open-hn-vcnv', 999);
  adminSockA.emit('open-hn-vcnv', -1);
  adminSockA.emit('open-hn-vcnv', 'invalid');
  await sleep(150);
  check('invalid open-hn-vcnv index does not crash server', (await call('/api/server')).status === 200);

  // 2. High 2: Viewer cannot control match; Room A broadcasts do not reach Room B
  let roomBLeaked = false;
  adminSockB.on('beginMatch', () => { roomBLeaked = true; });
  adminSockB.on('update-kd-question', () => { roomBLeaked = true; });

  viewerSockA.emit('beginMatch');
  viewerSockA.emit('open-hn-vcnv', 1);
  await sleep(150);
  const matchAfterViewer = (await call('/api/match', { token: roomA.token })).body;
  const vcnvAfterViewer = (await call('/api/rounds/vcnv', { token: roomA.token })).body;
  check('viewer cannot start match or open obstacle row', matchAfterViewer.position === 'H' && vcnvAfterViewer.questions[0]?.isOpen !== true);

  let viewerKdQuestion = null;
  viewerSockA.on('update-kd-question', (q) => { viewerKdQuestion = q; });
  adminSockA.emit('beginMatch');
  adminSockA.emit('broadcast-kd-question', { question: 'Q1', answer: 'TOP_SECRET', type: 'N' });
  await sleep(200);
  check('room A beginMatch and KD broadcast do not cross to room B', !roomBLeaked);
  check('KD question broadcast strips answer for non-staff', viewerKdQuestion?.question === 'Q1' && viewerKdQuestion?.answer === '', JSON.stringify(viewerKdQuestion));

  // 3. High 3: Round HTTP & Socket.IO sanitization
  await call('/api/rounds/vcnv', {
    token: roomA.token,
    method: 'PUT',
    body: {
      questions: [
        { id: 1, type: 'HN', value: 10, isOpen: false, isShown: false, question: 'Hidden Q', answer: 'SECRETROW' },
      ],
      obstacle: { question: 'Obs Q', answer: 'OBST ACLE', value: 80, imageFile: 'full-obstacle.png' },
      playerAnswers: [
        { answer: 'P0_VCNV', correct: false },
        { answer: '', correct: false },
        { answer: '', correct: false },
        { answer: '', correct: false },
      ],
      showResults: false,
      disabledPlayers: [],
      openRowCount: 0,
      obstacleBuzzes: [],
    },
  });
  const vcnvViewer = (await call('/api/rounds/vcnv', { token: viewerA.token })).body;
  check(
    'viewer VCNV round masks answers, hides unshown question, strips obstacle imageFile and live answers',
    vcnvViewer.questions[0].question === '' &&
      vcnvViewer.questions[0].answer === '*********' &&
      vcnvViewer.obstacle.answer === '********' &&
      vcnvViewer.obstacle.imageFile === undefined &&
      vcnvViewer.playerAnswers[0].answer === '',
    JSON.stringify(vcnvViewer),
  );

  await call('/api/rounds/tt', {
    token: roomA.token,
    method: 'PUT',
    body: {
      questions: [
        { id: 1, question: 'TT Q1', answer: 'TT_ANS_1', type: 'image', questionImage: 'q1.png', answerImage: 'a1.png' },
        { id: 2, question: 'TT Q2', answer: 'TT_ANS_2', type: 'image', questionImage: 'q2.png', answerImage: 'a2.png' },
      ],
      playerAnswers: [0, 1, 2, 3].map((playerIndex) => ({
        playerIndex, answer: '', timestamp: 0, readableTime: '', correct: false,
      })),
      showResults: false,
      activeQuestionIndex: 0,
      showAnswer: false,
      timerStartTimestamp: 0,
    },
  });
  const ttViewer = (await call('/api/rounds/tt', { token: viewerA.token })).body;
  check(
    'viewer TT round hides answers, answerImage, and non-active questions',
    ttViewer.questions[0].answer === '' &&
      ttViewer.questions[0].answerImage === undefined &&
      ttViewer.questions[1].question === '' &&
      ttViewer.questions[1].answer === '',
    JSON.stringify(ttViewer.questions),
  );

  let adminSawTt = null;
  let player1SawTt = null;
  let player0SawTt = null;
  adminSockA.on('update-tangtoc-data', (d) => { adminSawTt = d; });
  player1SockA.on('update-tangtoc-data', (d) => { player1SawTt = d; });
  player0SockA.on('update-tangtoc-data', (d) => { player0SawTt = d; });

  // Submitting while clock is stopped must be ignored (anti-cheat)
  player0SockA.emit('player-submit-answer-tangtoc', 'LATE_CHEAT');
  await sleep(150);
  check('TT submission while clock stopped is rejected', adminSawTt === null, JSON.stringify(adminSawTt?.playerAnswers?.[0]));

  await call('/api/config', { token: roomA.token, method: 'PATCH', body: { kdClockStartDelayMs: 0 } });
  adminSockA.emit('start-clock', 20);
  await sleep(150);
  player0SockA.emit('player-submit-answer-tangtoc', 'LIVE_SECRET_GUESS');
  await sleep(200);
  check(
    'live TT submission reaches admin and submitter only, not other players',
    adminSawTt?.playerAnswers?.[0]?.answer === 'LIVE_SECRET_GUESS' &&
      player0SawTt?.playerAnswers?.[0]?.answer === 'LIVE_SECRET_GUESS' &&
      player1SawTt?.playerAnswers?.[0]?.answer === '',
    JSON.stringify({
      admin: adminSawTt?.playerAnswers?.[0]?.answer,
      p0: player0SawTt?.playerAnswers?.[0]?.answer,
      p1: player1SawTt?.playerAnswers?.[0]?.answer,
    }),
  );

  // VCNV duplicate buzz blocked & VD early/self steal blocked
  player0SockA.emit('attempt-cnv-player');
  await sleep(100);
  player0SockA.emit('attempt-cnv-player');
  await sleep(100);
  const vcnvAfterBuzz = (await call('/api/rounds/vcnv', { token: roomA.token })).body;
  check('VCNV blocks repeat obstacle buzz from disabled player', vcnvAfterBuzz.obstacleBuzzes.length === 1, JSON.stringify(vcnvAfterBuzz.obstacleBuzzes));

  let stolenBy = null;
  adminSockA.on('player-steal-question', (idx) => { stolenBy = idx; });
  player1SockA.emit('player-steal-question');
  await sleep(100);
  check('VD blocks steal before 5s window opens', stolenBy === null, String(stolenBy));
  adminSockA.emit('start-5s-countdown-vd');
  await sleep(100);
  player0SockA.emit('player-steal-question');
  await sleep(100);
  check('VD blocks active player from stealing own question', stolenBy === null, String(stolenBy));
  player1SockA.emit('player-steal-question');
  await sleep(100);
  check('VD allows opponent steal during 5s window', stolenBy === 1, String(stolenBy));

  // Co-admin via admin secret cannot delete owner's room
  const coAdmin = (await call('/api/rooms/join', { method: 'POST', body: { code: roomA.code, secret: roomA.secrets.admin } })).body;
  const coAdminDel = await call('/api/rooms/current', { token: coAdmin.token, method: 'DELETE' });
  check('co-admin via room secret cannot delete owner room (403)', coAdminDel.status === 403, JSON.stringify(coAdminDel));

  // 4. High 4: Reject active/spoofed media on upload & archive import; safe serving headers
  const fakePngForm = new FormData();
  fakePngForm.append('file', new Blob([Buffer.from('<script>alert(1)</script>')], { type: 'image/png' }), 'evil.png');
  const spoofedUpload = await call('/api/media/tt', { token: roomA.token, method: 'POST', form: fakePngForm });
  check('spoofed PNG upload rejected with 415', spoofedUpload.status === 415, JSON.stringify(spoofedUpload));

  const baseEditorData = {
    uid: 'sec-test',
    dateModified: 0,
    uiConfig: { darkMode: true, pallette: 0, miscImageSrcNames: {} },
    matchData: { matchName: 'Sec', matchVersion: 24, matchPos: 0, players: ['A', 'B', 'C', 'D'].map((name) => ({ name, score: 0, isReady: false })) },
    questionBank: { kd: {}, vcnv: { cnv: '', questions: [] }, tt: { questions: [] }, vd: { questions: [] }, chp: { questions: [] } },
  };
  const htmlZip = new AdmZip();
  htmlZip.addFile('editorData.json', Buffer.from(JSON.stringify(baseEditorData)));
  htmlZip.addFile('misc/xss.html', Buffer.from('<html><script>alert(1)</script></html>'));
  const htmlForm = new FormData();
  htmlForm.append('file', new Blob([htmlZip.toBuffer()], { type: 'application/zip' }), 'xss.legion');
  const htmlImport = await call('/api/match/import-legion', { token: roomA.token, method: 'POST', form: htmlForm });
  check('archive containing HTML rejected with 415', htmlImport.status === 415, JSON.stringify(htmlImport));

  const validPngForm = new FormData();
  validPngForm.append('file', new Blob([PNG], { type: 'image/png' }), 'safe.png');
  const safeUp = await call('/api/media/tt', { token: roomA.token, method: 'POST', form: validPngForm });
  const served = await fetch(base + safeUp.body.url);
  check(
    'served media includes sandbox CSP, nosniff, and safe Content-Type',
    served.status === 200 &&
      served.headers.get('content-type')?.startsWith('image/png') &&
      served.headers.get('x-content-type-options') === 'nosniff' &&
      served.headers.get('content-security-policy') === "default-src 'none'; sandbox",
    JSON.stringify({
      ct: served.headers.get('content-type'),
      nosniff: served.headers.get('x-content-type-options'),
      csp: served.headers.get('content-security-policy'),
    }),
  );

  // 5. High 5: Oversized compressed editorData.json bomb rejected with 413
  const bombZip = new AdmZip();
  bombZip.addFile('editorData.json', Buffer.alloc(11 * 1024 * 1024, 0x20));
  const bombForm = new FormData();
  bombForm.append('file', new Blob([bombZip.toBuffer()], { type: 'application/zip' }), 'bomb.legion');
  const bombRes = await call('/api/match/import-legion', { token: roomA.token, method: 'POST', form: bombForm });
  check('oversized editorData.json zip bomb rejected with 413', bombRes.status === 413, JSON.stringify(bombRes));

  // 6. Medium 1: Account recovery disconnects live game sockets & blocks concurrent replay
  const [rec1, rec2] = await Promise.all([
    call('/api/accounts/recover', {
      method: 'POST',
      body: { username: host.username, recoveryCode: host.recoveryCode, newPassword: 'new-sec-password-1' },
    }),
    call('/api/accounts/recover', {
      method: 'POST',
      body: { username: host.username, recoveryCode: host.recoveryCode, newPassword: 'new-sec-password-2' },
    }),
  ]);
  const statuses = [rec1.status, rec2.status].sort();
  await sleep(250);
  check('concurrent recovery allows only one caller', statuses[0] === 200 && statuses[1] === 401, JSON.stringify(statuses));
  check('account recovery disconnects live host game socket', adminSockA.disconnected && adminSockB.disconnected);
} finally {
  for (const s of sockets) s.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exitCode = failures ? 1 : 0;
