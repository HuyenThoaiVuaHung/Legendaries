/**
 * Multiplayer KD flow. Part 1: KdFlow against a FakeServerTime (exact timing).
 * Part 2: the same rules over real sockets in a fresh hosted room (multi-room server),
 * so rule patches never touch the default room or utils/config.json.
 * Run: node tests/kd-flow.mjs <port>   (after npm run build)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io } from 'socket.io-client';
import { loadGameRules } from '../dist/game.rules.js';
import { KdFlow } from '../dist/services/kd-flow.js';
import { GameSessionState } from '../dist/state/game.state.js';
import { MatchStore } from '../dist/state/match.store.js';
import { FakeServerTime } from '../dist/time/fake-server-time.js';
import { RoomTimers } from '../dist/time/room-timers.js';

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  kd-flow: ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  kd-flow: ${name} - ${error.message}`);
  }
};

// ------------------------------------------------------------ unit (fake time)

const dir = mkdtempSync(join(tmpdir(), 'kd-flow-'));
const QUESTION_SCORE = 20;

const make = (overrides = {}) => {
  const time = new FakeServerTime();
  const rules = { ...loadGameRules(), ...overrides };
  const events = [];
  const channel = { emit: (name, ...args) => (events.push([name, ...args]), true) };
  const store = new MatchStore(join(dir, `match-${Math.random()}.json`), () => {}, (kind) => join(dir, `${Math.random()}-${kind}.json`));
  store.round('kd').update((d) => { d.gamemode = 'M'; });
  store.updateMatch((m) => { m.players[0].score = QUESTION_SCORE; });
  const session = new GameSessionState();
  const timers = new RoomTimers(channel, store, session, rules, time);
  const flow = new KdFlow(channel, store, session, timers, rules, time);
  const count = (name, pick = () => true) => events.filter(([n, ...a]) => n === name && pick(...a)).length;
  const score = () => store.getMatch().players[0].score;
  // Open the buzz window: arm delay elapses.
  const open = () => { flow.beginQuestion(); time.advance(rules.kdBuzzArmDelayMs); };
  return { time, rules, events, store, session, flow, count, score, open };
};

await check('buzzer stays locked through the arm delay, then opens', () => {
  const t = make();
  t.flow.beginQuestion();
  t.time.advance(t.rules.kdBuzzArmDelayMs - 1);
  assert.equal(t.flow.currentPhase, 'reading');
  assert.equal(t.session.kdBuzzerOpen, false);
  assert.equal(t.flow.buzz(0), false);
  assert.equal(t.count('enable-answer-button-kd'), 0);
  t.time.advance(1);
  assert.equal(t.flow.currentPhase, 'buzzWindow');
  assert.equal(t.session.kdBuzzerOpen, true);
  assert.equal(t.count('enable-answer-button-kd'), 1);
});

await check('last-second buzz inside grace wins with no time-up cue first', () => {
  const t = make();
  t.open();
  t.time.advance(t.rules.kdBuzzWindowMs + t.rules.submissionGraceMs - 1);
  assert.equal(t.flow.currentPhase, 'buzzWindow');
  assert.ok(t.flow.buzz(2));
  assert.equal(t.session.kdTurnPlayerIndex, 2);
  assert.equal(t.count('play-sfx', (c) => c === 'KD_WRONG'), 0);
  assert.equal(t.count('player-got-turn-kd', (p) => p === 2), 1);
  assert.equal(t.flow.currentPhase, 'answering');
  t.time.advance(10_000);
  assert.equal(t.count('enable-answer-button-kd'), 1);
});

await check('buzz after the grace window is rejected', () => {
  const late = make();
  late.open();
  late.time.advance(late.rules.kdBuzzWindowMs + late.rules.submissionGraceMs + 1);
  assert.equal(late.flow.buzz(0), false);
  assert.equal(late.flow.currentPhase, 'awaitingMark');
  assert.equal(late.session.kdTurnPlayerIndex, -1);
  assert.equal(late.session.kdBuzzerOpen, false);
});

await check('first buzz wins; later presses ignored', () => {
  const t = make();
  t.open();
  assert.ok(t.flow.buzz(1));
  assert.equal(t.flow.buzz(3), false);
  assert.equal(t.session.kdTurnPlayerIndex, 1);
});

await check('stale question and wrong player marks are rejected with no score change', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  const seq = t.flow.questionSeq;
  assert.equal(t.flow.mark('correct', { questionSeq: seq - 1, playerIndex: 0 }), 'stale-question');
  assert.equal(t.flow.mark('correct', { questionSeq: seq, playerIndex: 1 }), 'wrong-player');
  assert.equal(t.score(), QUESTION_SCORE);
  assert.equal(t.flow.currentPhase, 'answering');
  const idle = make();
  idle.open();
  assert.equal(idle.flow.mark('wrong', { questionSeq: idle.flow.questionSeq, playerIndex: -1 }), 'bad-phase');
});

await check('marks resolve the question and never reopen the buzzer', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  assert.equal(t.flow.mark('correct', { questionSeq: t.flow.questionSeq, playerIndex: 0 }), null);
  assert.equal(t.score(), QUESTION_SCORE + t.rules.kdCorrectPoints);
  assert.equal(t.flow.currentPhase, 'resolved');
  assert.equal(t.session.kdBuzzerOpen, false);
  assert.equal(t.count('enable-answer-button-kd'), 1);
  assert.equal(t.flow.buzz(0), false);
  assert.equal(t.session.kdCurrentQuestionNo, 1);
  assert.equal(t.count('kd-resolved'), 1);
});

await check('spam while the next question is arming takes no turn', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  t.flow.mark('correct', { questionSeq: t.flow.questionSeq, playerIndex: 0 });
  t.flow.beginQuestion();
  for (let i = 0; i < 10; i++) {
    t.time.advance(t.rules.kdBuzzArmDelayMs / 10 - 1);
    assert.equal(t.flow.buzz(1), false);
  }
  assert.equal(t.session.kdTurnPlayerIndex, -1);
});

await check('manual expiry changes no score, plays no cue, keeps the buzzer locked', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  t.time.advance(t.rules.kdDecisionMs);
  assert.equal(t.flow.currentPhase, 'awaitingMark');
  assert.equal(t.score(), QUESTION_SCORE);
  assert.equal(t.session.kdTurnPlayerIndex, 0);
  assert.equal(t.session.kdBuzzerOpen, false);
  assert.equal(t.count('play-sfx', (c) => c === 'KD_WRONG'), 0);
  assert.equal(t.flow.mark('wrong', { questionSeq: t.flow.questionSeq, playerIndex: 0 }), null);
  assert.equal(t.score(), QUESTION_SCORE - t.rules.kdWrongPenalty);
});

await check('manual buzz-window expiry waits for no-answer with turn -1', () => {
  const t = make();
  t.open();
  t.time.advance(t.rules.kdBuzzWindowMs + t.rules.submissionGraceMs);
  assert.equal(t.flow.currentPhase, 'awaitingMark');
  assert.equal(t.flow.mark('correct', { questionSeq: t.flow.questionSeq, playerIndex: -1 }), 'wrong-player');
  assert.equal(t.flow.mark('noAnswer', { questionSeq: t.flow.questionSeq, playerIndex: -1 }), null);
  assert.equal(t.flow.currentPhase, 'resolved');
});

await check('autoWrong applies the penalty exactly once and resolves', () => {
  const t = make({ kdTimeUpMode: 'autoWrong' });
  t.open();
  t.flow.buzz(0);
  t.time.advance(t.rules.kdDecisionMs);
  assert.equal(t.score(), QUESTION_SCORE - t.rules.kdWrongPenalty);
  assert.equal(t.flow.currentPhase, 'resolved');
  assert.equal(t.count('play-sfx', (c) => c === 'KD_WRONG'), 1);
  assert.deepEqual(
    { v: t.flow.state().lastMark.verdict, a: t.flow.state().lastMark.auto, d: t.flow.state().lastMark.scoreDelta },
    { v: 'wrong', a: true, d: -t.rules.kdWrongPenalty },
  );
  t.time.advance(20_000);
  assert.equal(t.score(), QUESTION_SCORE - t.rules.kdWrongPenalty);
  assert.equal(t.count('kd-resolved'), 1);
  assert.equal(t.session.kdBuzzerOpen, false);
});

await check('autoWrong never goes below zero and records the applied delta', () => {
  const t = make({ kdTimeUpMode: 'autoWrong' });
  t.store.updateMatch((m) => { m.players[0].score = 2; });
  t.open();
  t.flow.buzz(0);
  t.time.advance(t.rules.kdDecisionMs);
  assert.equal(t.score(), 0);
  assert.equal(t.flow.state().lastMark.scoreDelta, -2);
});

await check('autoWrong with nobody buzzing resolves noAnswer', () => {
  const t = make({ kdTimeUpMode: 'autoWrong' });
  t.open();
  t.time.advance(t.rules.kdBuzzWindowMs + t.rules.submissionGraceMs);
  const mark = t.flow.state().lastMark;
  assert.deepEqual([mark.verdict, mark.playerIndex, mark.scoreDelta, mark.auto], ['noAnswer', -1, 0, true]);
  assert.equal(t.flow.currentPhase, 'resolved');
});

await check('undo restores the score and a re-grade is accepted once', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  const seq = t.flow.questionSeq;
  t.flow.mark('correct', { questionSeq: seq, playerIndex: 0 });
  assert.equal(t.flow.undo(), null);
  assert.equal(t.score(), QUESTION_SCORE);
  assert.equal(t.flow.state().lastMark, null);
  assert.equal(t.flow.undo(), 'nothing-to-undo');
  t.open();
  const phase = t.flow.currentPhase;
  assert.equal(t.flow.mark('wrong', { questionSeq: seq, playerIndex: 0 }), null);
  assert.equal(t.score(), QUESTION_SCORE - t.rules.kdWrongPenalty);
  assert.equal(t.flow.currentPhase, phase);
  assert.equal(t.flow.mark('wrong', { questionSeq: seq, playerIndex: 0 }), 'stale-question');
  assert.equal(t.score(), QUESTION_SCORE - t.rules.kdWrongPenalty);
});

await check('reset turn reopens a fresh buzz window for the same question', () => {
  const t = make();
  t.open();
  t.flow.buzz(0);
  const seq = t.flow.questionSeq;
  t.flow.restartBuzzWindow();
  assert.equal(t.flow.questionSeq, seq);
  assert.equal(t.flow.currentPhase, 'buzzWindow');
  assert.equal(t.session.kdTurnPlayerIndex, -1);
  assert.equal(t.count('enable-answer-button-kd'), 2);
  assert.ok(t.flow.buzz(3));
});

rmSync(dir, { recursive: true, force: true });

// ---------------------------------------------------------------- sockets

const port = process.argv[2];
if (port) await sockets(`http://localhost:${port}`);
else console.log('SKIP  kd-flow: socket cases (no port given)');

console.log(failures === 0 ? 'kd-flow: ALL PASS' : `kd-flow: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

async function sockets(base) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const api = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
    return res.json().catch(() => null);
  };
  const host = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ username: `kdflow${Date.now().toString(36)}`, password: 'password-123' }) });
  const room = await api('/api/rooms', { method: 'POST', headers: { authorization: `Bearer ${host.token}` }, body: '{}' });
  const player0 = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: room.code, secret: room.secrets.players[0] }) });
  const adminLogin = { token: room.token };
  const adminLogin2 = { token: room.token };
  const playerLogin = player0;
  const auth = { authorization: `Bearer ${room.token}` };
  const connect = async (token) => {
    const socket = io(base, { auth: { token }, transports: ['websocket'] });
    await new Promise((resolve) => socket.once('connect', resolve));
    const seen = [];
    socket.onAny((name, ...args) => seen.push({ name, args, at: Date.now() }));
    return { socket, seen };
  };
  const admin = await connect(adminLogin.token);
  const admin2 = await connect(adminLogin2.token);
  const player = await connect(playerLogin.token);
  const phases = () => admin.seen.filter((e) => e.name === 'kd-phase').map((e) => e.args[0]);
  const lastPhase = () => phases().at(-1);
  const until = async (pred, ms = 2000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await wait(10); }
    return false;
  };
  const score = async () => (await api('/api/match', { headers: auth })).players[0].score;
  const question = { question: 'q', answer: 'a', type: 'text' };
  const RULES = { kdBuzzArmDelayMs: 300, kdBuzzWindowMs: 300, kdDecisionMs: 300, submissionGraceMs: 150, kdTimeUpMode: 'manual' };
  await api('/api/config', { method: 'PATCH', headers: auth, body: JSON.stringify(RULES) });
  await api('/api/rounds/kd', { method: 'PATCH', headers: auth, body: JSON.stringify({ gamemode: 'M' }) });
  admin.socket.emit('start-turn-kd', 10);
  await wait(100);
  const base0 = await score();
  const next = async (a = admin, replaces) => {
    const before = phases().length;
    a.socket.emit('broadcast-kd-question', question, replaces);
    assert.ok(await until(() => phases().length > before), 'question phase');
    return lastPhase().questionSeq;
  };

  try {
    await check('socket: spam during the arm delay is ignored, then buzz takes the turn', async () => {
      const seq = await next();
      for (let i = 0; i < 8; i++) { player.socket.emit('get-turn-kd'); await wait(10); }
      assert.equal(admin.seen.filter((e) => e.name === 'player-got-turn-kd').length, 0);
      assert.equal(lastPhase().phase, 'reading');
      assert.ok(await until(() => lastPhase().phase === 'buzzWindow'));
      player.socket.emit('get-turn-kd');
      assert.ok(await until(() => lastPhase().phase === 'answering'));
      assert.equal(lastPhase().turnPlayerIndex, 0);
      assert.equal(lastPhase().questionSeq, seq);
    });

    await check('socket: stale and wrong-player marks rejected, valid mark scores', async () => {
      const seq = lastPhase().questionSeq;
      const rejects = () => admin.seen.filter((e) => e.name === 'kd-mark-rejected').map((e) => e.args[0].reason);
      admin.socket.emit('correct-mark-kd', { questionSeq: seq - 1, playerIndex: 0 });
      admin.socket.emit('correct-mark-kd', { questionSeq: seq, playerIndex: 1 });
      assert.ok(await until(() => rejects().length === 2));
      assert.deepEqual(rejects(), ['stale-question', 'wrong-player']);
      assert.equal(await score(), base0);
      const enables = admin.seen.filter((e) => e.name === 'enable-answer-button-kd').length;
      admin.socket.emit('correct-mark-kd', { questionSeq: seq, playerIndex: 0 });
      assert.ok(await until(() => lastPhase().phase === 'resolved'));
      assert.equal(await score(), base0 + 10);
      await wait(150);
      assert.equal(admin.seen.filter((e) => e.name === 'enable-answer-button-kd').length, enables);
    });

    await check('socket: two admins advancing with the same replacesSeq advance once', async () => {
      const seq = lastPhase().questionSeq;
      const before = phases().filter((p) => p.phase === 'reading').length;
      admin.socket.emit('broadcast-kd-question', question, seq);
      admin2.socket.emit('broadcast-kd-question', question, seq);
      await wait(250);
      assert.equal(phases().filter((p) => p.phase === 'reading').length, before + 1);
      assert.equal(lastPhase().questionSeq, seq + 1);
    });

    await check('socket: last-second buzz within grace takes the turn, no time-up cue', async () => {
      assert.ok(await until(() => lastPhase().phase === 'buzzWindow'));
      const opened = admin.seen.findLast((e) => e.name === 'enable-answer-button-kd').at;
      await wait(opened + RULES.kdBuzzWindowMs + 50 - Date.now());
      player.socket.emit('get-turn-kd');
      assert.ok(await until(() => lastPhase().phase === 'answering'));
      const gotTurn = admin.seen.findLast((e) => e.name === 'player-got-turn-kd');
      assert.ok(gotTurn);
      assert.equal(admin.seen.filter((e) => e.name === 'play-sfx' && e.args[0] === 'KD_WRONG' && e.at >= opened).length, 0);
    });

    await check('socket: manual expiry keeps score and buzzer locked; undo and re-grade work', async () => {
      assert.ok(await until(() => lastPhase().phase === 'awaitingMark', 1500));
      assert.equal(await score(), base0 + 10);
      const seq = lastPhase().questionSeq;
      admin.socket.emit('wrong-mark-kd', { questionSeq: seq, playerIndex: 0 });
      assert.ok(await until(() => lastPhase().phase === 'resolved'));
      assert.equal(await score(), base0 + 5);
      admin.socket.emit('undo-mark-kd');
      assert.ok(await until(() => lastPhase().lastMark === null));
      assert.equal(await score(), base0 + 10);
      admin.socket.emit('undo-mark-kd');
      assert.ok(await until(() => admin.seen.some((e) => e.name === 'kd-mark-rejected' && e.args[0].reason === 'nothing-to-undo')));
      await next();
      admin.socket.emit('correct-mark-kd', { questionSeq: seq, playerIndex: 0 });
      assert.ok(await until(() => admin.seen.some((e) => e.name === 'kd-resolved' && e.args[0].questionSeq === seq && e.args[0].verdict === 'correct')));
      assert.equal(await score(), base0 + 20);
      assert.notEqual(lastPhase().phase, 'resolved');
    });

    await check('socket: autoWrong applies the penalty once', async () => {
      await api('/api/config', { method: 'PATCH', headers: auth, body: JSON.stringify({ kdTimeUpMode: 'autoWrong' }) });
      const startScore = await score();
      assert.ok(await until(() => lastPhase().phase === 'buzzWindow'));
      player.socket.emit('get-turn-kd');
      assert.ok(await until(() => lastPhase().phase === 'resolved', 1500));
      await wait(500);
      assert.equal(await score(), startScore - 5);
      const auto = admin.seen.filter((e) => e.name === 'kd-resolved' && e.args[0].auto);
      assert.equal(auto.length, 1);
    });
  } finally {
    for (const c of [admin, admin2, player]) c.socket.close();
  }
}
