/**
 * High-concurrency game-logic suite: contested actions must resolve to exactly
 * one well-defined outcome when many clients act at the same instant.
 * Part 1 drives the services against FakeServerTime (exact interleavings and ties).
 * Part 2 drives real socket.io clients in fresh hosted rooms (multi-room server),
 * all sections running in parallel, so rule patches never touch the default room.
 * Randomness is seeded: CONCURRENCY_SEED overrides the fixed default; the seed is printed on failure.
 * Run: node tests/concurrency.mjs <port>   (after npm run build)
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

const SEED = Number(process.env.CONCURRENCY_SEED ?? 20260101);
const STARTED = Date.now();
let failures = 0;
let checks = 0;

// ------------------------------------------------------------- seeded random

const hash = (text) => [...text].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
const makeRng = (name) => {
  let a = (SEED ^ hash(name)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle: (list) => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
  return rng;
};

const check = async (name, fn) => {
  checks++;
  try {
    await fn(makeRng(name));
    console.log('PASS  concurrency: ' + name);
  } catch (error) {
    failures++;
    console.log('FAIL  concurrency: ' + name + ' [seed ' + SEED + '] - ' + (error.stack ?? error.message).split('\n').slice(0, 4).join(' | '));
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------- part 1: fake time

const dir = mkdtempSync(join(tmpdir(), 'concurrency-'));
const START_SCORE = 20;

const make = (overrides = {}, scores = [START_SCORE, START_SCORE, START_SCORE, START_SCORE]) => {
  const time = new FakeServerTime();
  const rules = { ...loadGameRules(), ...overrides };
  const events = [];
  const channel = { emit: (name, ...args) => (events.push([name, ...args]), true) };
  const store = new MatchStore(join(dir, 'match-' + Math.random() + '.json'), () => {}, (kind) => join(dir, Math.random() + '-' + kind + '.json'));
  store.round('kd').update((d) => { d.gamemode = 'M'; });
  store.updateMatch((m) => { scores.forEach((s, i) => { m.players[i].score = s; }); });
  const session = new GameSessionState();
  const timers = new RoomTimers(channel, store, session, rules, time);
  const flow = new KdFlow(channel, store, session, timers, rules, time);
  const count = (name, from = 0) => events.slice(from).filter(([n]) => n === name).length;
  const score = (i = 0) => store.getMatch().players[i].score;
  const open = () => { flow.beginQuestion(); time.advance(rules.kdBuzzArmDelayMs); };
  const cmd = (playerIndex, verdictSeq = flow.questionSeq) => ({ questionSeq: verdictSeq, playerIndex });
  return { time, rules, events, store, session, timers, flow, count, score, open, cmd };
};

await check('KD buzz race: one got-turn per question when every player buzzes in the same tick', (rng) => {
  const t = make();
  for (let q = 0; q < 60; q++) {
    const from = t.events.length;
    t.flow.beginQuestion();
    // Spam through the whole arm delay at random instants: never wins.
    let spent = 0;
    while (spent < t.rules.kdBuzzArmDelayMs - 1) {
      const step = Math.min(rng.int(1, 25), t.rules.kdBuzzArmDelayMs - 1 - spent);
      t.time.advance(step);
      spent += step;
      assert.equal(t.flow.buzz(rng.int(0, 3)), false, 'buzz during arm delay won');
    }
    assert.equal(t.count('player-got-turn-kd', from), 0);
    t.time.advance(t.rules.kdBuzzArmDelayMs - spent);
    const order = rng.shuffle([0, 1, 2, 3]);
    const results = order.map((p) => t.flow.buzz(p));
    assert.deepEqual(results, [true, false, false, false]);
    assert.equal(t.session.kdTurnPlayerIndex, order[0]);
    assert.equal(t.count('player-got-turn-kd', from), 1);
    assert.equal(t.count('disable-answer-button-kd', from), 1);
    assert.equal(t.flow.mark(rng.pick(['correct', 'wrong']), t.cmd(order[0])), null);
  }
});

await check('KD grace boundary: a buzz inside grace beats the close, after grace never does', (rng) => {
  const t = make();
  const { kdBuzzWindowMs: win, submissionGraceMs: grace } = t.rules;
  for (let i = 0; i < 40; i++) {
    t.open();
    const offset = i === 0 ? grace - 1 : rng.int(0, grace - 1);
    t.time.advance(win + offset);
    assert.equal(t.flow.buzz(rng.int(0, 3)), true, 'buzz at +' + offset + ' inside grace lost');
    assert.equal(t.flow.currentPhase, 'answering');
    t.flow.mark('noAnswer', t.cmd(t.session.kdTurnPlayerIndex));
  }
  for (let i = 0; i < 40; i++) {
    t.open();
    const offset = i === 0 ? grace + 1 : rng.int(grace + 1, grace + 500);
    t.time.advance(win + offset);
    const from = t.events.length;
    assert.equal(t.flow.buzz(rng.int(0, 3)), false, 'buzz at +' + offset + ' after grace won');
    assert.equal(t.count('player-got-turn-kd', from), 0);
    assert.equal(t.flow.currentPhase, 'awaitingMark');
    assert.equal(t.session.kdTurnPlayerIndex, -1);
    t.flow.mark('noAnswer', t.cmd(-1));
  }
});

await check('KD exact tie at the close instant resolves one way, never both', () => {
  for (const buzzFirst of [true, false]) {
    const t = make();
    t.open();
    const closeAt = t.time.mono() + t.rules.kdBuzzWindowMs + t.rules.submissionGraceMs;
    let won;
    const press = () => { won = t.flow.buzz(1); };
    if (buzzFirst) t.time.schedule(closeAt, press);
    t.time.advance(t.rules.kdBuzzWindowMs); // expiry arms the deferred close
    if (!buzzFirst) t.time.schedule(closeAt, press);
    t.time.advance(t.rules.submissionGraceMs);
    assert.equal(won, buzzFirst, 'tie order must decide the outcome');
    assert.equal(t.flow.currentPhase, buzzFirst ? 'answering' : 'awaitingMark');
    assert.equal(t.count('player-got-turn-kd'), buzzFirst ? 1 : 0);
  }
});

await check('KD multi-admin: identical and conflicting marks apply exactly once', (rng) => {
  const t = make();
  for (let q = 0; q < 60; q++) {
    t.open();
    const winner = rng.int(0, 3);
    assert.ok(t.flow.buzz(winner));
    const before = t.score(winner);
    const resolvedBefore = t.count('kd-resolved');
    const verdicts = Array.from({ length: rng.int(2, 9) }, () => (q % 2 === 0 ? 'correct' : rng.pick(['correct', 'wrong'])));
    const cmd = t.cmd(winner);
    const results = verdicts.map((v) => t.flow.mark(v, cmd));
    const applied = results.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
    assert.deepEqual(applied, [0], 'exactly the first mark is applied');
    for (const reason of results.slice(1)) assert.ok(['bad-phase', 'stale-question'].includes(reason), String(reason));
    const delta = verdicts[0] === 'correct' ? t.rules.kdCorrectPoints : -Math.min(t.rules.kdWrongPenalty, Math.max(0, before));
    assert.equal(t.score(winner), before + delta);
    assert.equal(t.count('kd-resolved') - resolvedBefore, 1);
  }
});

await check('KD multi-admin: marks for the wrong player or a stale question never score', (rng) => {
  const t = make();
  t.open();
  assert.ok(t.flow.buzz(2));
  const seq = t.flow.questionSeq;
  const before = [0, 1, 2, 3].map((i) => t.score(i));
  const bad = rng.shuffle([
    ['correct', { questionSeq: seq, playerIndex: 0 }],
    ['wrong', { questionSeq: seq, playerIndex: 3 }],
    ['correct', { questionSeq: seq - 1, playerIndex: 2 }],
    ['wrong', { questionSeq: seq + 5, playerIndex: 2 }],
    ['noAnswer', { questionSeq: seq, playerIndex: -1 }],
  ]);
  for (const [verdict, cmd] of bad) assert.notEqual(t.flow.mark(verdict, cmd), null);
  assert.deepEqual([0, 1, 2, 3].map((i) => t.score(i)), before);
  assert.equal(t.flow.currentPhase, 'answering');
  assert.equal(t.flow.mark('correct', { questionSeq: seq, playerIndex: 2 }), null);
});

await check('KD undo racing a re-grade: score always equals the surviving mark', (rng) => {
  const t = make();
  for (let q = 0; q < 80; q++) {
    t.open();
    const winner = rng.int(0, 3);
    t.flow.buzz(winner);
    const before = t.score(winner);
    const seq = t.flow.questionSeq;
    assert.equal(t.flow.mark(rng.pick(['correct', 'wrong']), t.cmd(winner)), null);
    const base = t.count('kd-resolved');
    const ops = rng.shuffle(
      Array.from({ length: rng.int(3, 8) }, () => rng.pick(['undo', 'undo', 'regrade-correct', 'regrade-wrong'])),
    );
    let undos = 0;
    let regrades = 0;
    for (const op of ops) {
      const reason = op === 'undo' ? t.flow.undo() : t.flow.mark(op === 'regrade-correct' ? 'correct' : 'wrong', { questionSeq: seq, playerIndex: winner });
      if (reason === null) (op === 'undo' ? undos++ : regrades++);
      const mark = t.flow.state().lastMark;
      assert.equal(t.score(winner), before + (mark ? mark.scoreDelta : 0), 'score drifted from the surviving mark after ' + op);
      assert.ok(t.score(winner) >= 0);
    }
    assert.ok(undos >= regrades && undos - regrades <= 1, 'undos=' + undos + ' regrades=' + regrades);
    assert.equal(t.count('kd-resolved') - base, regrades);
  }
});

await check('KD score integrity: deltas sum exactly and the wrong penalty clamps at zero', (rng) => {
  for (const mode of ['manual', 'autoWrong']) {
    const start = [0, 1, 4, 12];
    const t = make({ kdTimeUpMode: mode }, start);
    const expected = [...start];
    for (let q = 0; q < 150; q++) {
      t.open();
      const winner = rng.int(0, 3);
      t.flow.buzz(winner);
      const before = t.score(winner);
      if (mode === 'autoWrong' && rng.next() < 0.5) t.time.advance(t.rules.kdDecisionMs);
      else t.flow.mark(rng.pick(['correct', 'wrong']), t.cmd(winner));
      let mark = t.flow.state().lastMark;
      assert.ok(mark && mark.playerIndex === winner);
      if (rng.next() < 0.3) {
        assert.equal(t.flow.undo(), null);
        mark = null;
      }
      if (mark) {
        expected[winner] += mark.scoreDelta;
        if (mark.verdict === 'wrong') assert.equal(mark.scoreDelta, -Math.min(t.rules.kdWrongPenalty, before));
        if (mark.verdict === 'correct') assert.equal(mark.scoreDelta, t.rules.kdCorrectPoints);
      }
      for (let i = 0; i < 4; i++) {
        assert.equal(t.score(i), expected[i], mode + ' player ' + i + ' question ' + q);
        assert.ok(t.score(i) >= 0);
      }
    }
  }
});

/** Invariants every countdown log must satisfy, whatever the interleaving. */
const checkTimerLog = (views, label) => {
  let lastSeq = -1;
  let armed = false;
  let prev = null;
  for (const view of views) {
    assert.ok(view.seq > lastSeq, label + ': seq must strictly increase (' + lastSeq + ' -> ' + view.seq + ')');
    lastSeq = view.seq;
    assert.ok(view.remainingMs >= 0 && view.remainingMs <= view.durationMs, label + ': remainder out of range');
    if (view.status === 'pending' || view.status === 'running') {
      if (!(prev && prev.status === 'pending' && view.status === 'running')) armed = true;
    }
    if (view.status === 'expired') {
      assert.ok(armed, label + ': expired without a live run (double expiry)');
      assert.equal(view.remainingMs, 0);
      armed = false;
    }
    if (view.status === 'paused' || view.status === 'stopped') armed = false;
    if (view.status === 'paused' && prev?.status === 'paused') assert.fail(label + ': paused twice in a row');
    prev = view;
  }
};

await check('clock under contention: seq strictly increases, expiry once per run, nothing left scheduled', (rng) => {
  for (let round = 0; round < 40; round++) {
    const t = make();
    const main = [];
    const steal = [];
    for (let step = 0; step < 120; step++) {
      switch (rng.int(0, 6)) {
        case 0: t.timers.startMain(rng.int(1, 6), rng.pick([0, 0, 500, 1000])); break;
        case 1: case 2: t.timers.togglePause(); break;
        case 3: t.timers.main.stop(); break;
        case 4: t.timers.startVdSteal(); break;
        case 5: t.timers.stopVdSteal(); break;
        default: t.time.advance(rng.int(0, 2500));
      }
    }
    for (const [name, view] of t.events) {
      if (name !== 'clock-state') continue;
      (view.id === 'main' ? main : view.id === 'vdSteal' ? steal : []).push(view);
    }
    checkTimerLog(main, 'main round ' + round);
    checkTimerLog(steal, 'vdSteal round ' + round);
    t.time.advance(60_000);
    for (const countdown of [t.timers.main, t.timers.vdSteal]) {
      assert.ok(!countdown.isLive(), 'still live after a minute');
    }
    t.timers.main.stop();
    t.timers.vdSteal.stop();
    t.time.advance(10_000);
    assert.equal(t.time.pending(), 0, 'callbacks left scheduled after everything ended');
  }
});

await check('clock: simultaneous start/pause/resume leave one consistent snapshot', (rng) => {
  const t = make();
  t.timers.startMain(10, 0);
  t.time.advance(3000);
  for (let i = 0; i < 25; i++) {
    const op = rng.int(0, 2);
    if (op === 0) t.timers.togglePause();
    else if (op === 1) t.timers.togglePause();
    else t.time.advance(rng.int(1, 40));
  }
  const view = t.timers.main.view();
  const snap = t.timers.snapshot().main;
  assert.equal(snap.seq, view.seq);
  assert.equal(snap.status, view.status);
  const last = t.events.filter(([n, v]) => n === 'clock-state' && v.id === 'main').at(-1)[1];
  assert.equal(last.seq, snap.seq, 'last broadcast equals the server snapshot');
  assert.equal(last.status, snap.status);
});

rmSync(dir, { recursive: true, force: true });

// ----------------------------------------------------- part 2: real sockets

const port = process.argv[2];
if (port) await sockets('http://localhost:' + port);
else console.log('SKIP  concurrency: socket cases (no port given)');

console.log(
  failures === 0
    ? 'concurrency: ALL PASS (' + checks + ' checks, seed ' + SEED + ', ' + ((Date.now() - STARTED) / 1000).toFixed(1) + 's)'
    : 'concurrency: ' + failures + ' FAILURES (seed ' + SEED + ')',
);
process.exit(failures === 0 ? 0 : 1);

async function sockets(base) {
  const api = async (path, opts = {}) => {
    const res = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) } });
    return res.json().catch(() => null);
  };
  let accounts = 0;
  const open = [];

  const connect = async (token) => {
    const socket = io(base, { auth: { token }, transports: ['websocket'], forceNew: true });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    const seen = [];
    socket.onAny((name, ...args) => seen.push({ name, args, at: Date.now() }));
    open.push(socket);
    return { socket, seen, emit: (...a) => socket.emit(...a) };
  };

  /** Fresh hosted room with N admin sockets and N players (one per seat). */
  const fixture = async ({ rules = {}, admins = 1, players = 4 } = {}) => {
    const host = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ username: 'conc' + Date.now().toString(36) + (accounts++), password: 'password-123' }) });
    const room = await api('/api/rooms', { method: 'POST', headers: { authorization: 'Bearer ' + host.token }, body: '{}' });
    assert.ok(room?.token, 'room creation failed: ' + JSON.stringify(room));
    const auth = { authorization: 'Bearer ' + room.token };
    const call = (path, method, body) => api(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
    await call('/api/config', 'PATCH', rules);
    const adminSockets = [];
    for (let i = 0; i < admins; i++) adminSockets.push(await connect(room.token));
    const playerSockets = [];
    for (let i = 0; i < players; i++) {
      const joined = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ code: room.code, secret: room.secrets.players[i] }) });
      playerSockets.push(await connect(joined.token));
    }
    return {
      room, auth, call, admins: adminSockets, players: playerSockets,
      match: () => call('/api/match', 'GET'),
      score: async (i) => (await call('/api/match', 'GET')).players[i].score,
      setScore: async (i, score) => call('/api/match/players/' + i, 'PATCH', { player: { id: i + 1, name: 'P' + (i + 1), score, isReady: true } }),
      round: (kind) => call('/api/rounds/' + kind, 'GET'),
      position: (position) => call('/api/match/position', 'PATCH', { position }),
    };
  };

  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await wait(5); }
    return pred();
  };
  const settle = () => wait(150);
  const named = (client, name, from = 0) => client.seen.slice(from).filter((e) => e.name === name);
  const clockViews = (client, id) => client.seen.filter((e) => e.name === 'clock-state' && e.args[0].id === id).map((e) => e.args[0]);

  const sections = [];

  // ----------------------------------------------------------- KD sockets
  sections.push(check('sockets KD: buzz race, multi-admin marks, advance race, undo vs re-grade, grace', async (rng) => {
    const RULES = { kdBuzzArmDelayMs: 400, kdBuzzWindowMs: 300, kdDecisionMs: 500, submissionGraceMs: 300, kdTimeUpMode: 'manual' };
    const f = await fixture({ rules: RULES, admins: 3, players: 4 });
    const [A, P] = [f.admins, f.players];
    const everyone = [...A, ...P];
    await f.call('/api/rounds/kd', 'PATCH', { gamemode: 'M' });
    A[0].emit('start-turn-kd', 40);
    await wait(100);
    const phases = () => A[0].seen.filter((e) => e.name === 'kd-phase').map((e) => e.args[0]);
    const last = () => phases().at(-1);
    const question = { question: 'q', answer: 'a', type: 'text' };
    let seq = 0;
    const advance = async () => {
      const marks = everyone.map((c) => c.seen.length);
      const readings = () => A[0].seen.slice(marks[0]).filter((e) => e.name === 'kd-phase' && e.args[0].phase === 'reading').length;
      // every admin sends the same advance at once; only the first may land
      await Promise.all(rng.shuffle(A).map(async (a) => a.emit('broadcast-kd-question', question, seq)));
      assert.ok(await until(() => readings() >= 1), 'question never advanced');
      return { marks, readings };
    };
    const buzzAll = async () => {
      await Promise.all(rng.shuffle([...P, ...P]).map(async (p) => p.emit('get-turn-kd')));
    };
    const turnsSeen = (marks) => everyone.map((c, i) => named(c, 'player-got-turn-kd', marks[i]).map((e) => e.args[0]));
    const openedAt = () => named(A[0], 'enable-answer-button-kd').at(-1).at;
    const rejections = (marks) => A.reduce((n, a, i) => n + named(a, 'kd-mark-rejected', marks[i]).length, 0);
    const resolvedSince = (mark0) => named(A[0], 'kd-resolved', mark0);
    let expected = null;

    const variants = ['same-mark', 'conflict', 'undo-race', 'wrong-clamp', 'grace-in', 'grace-out', 'same-mark', 'conflict'];
    for (const variant of variants) {
      const { marks, readings } = await advance();
      // Spam while the question is still arming: nobody takes the turn.
      for (let k = 0; k < 3; k++) { await Promise.all(P.map(async (p) => p.emit('get-turn-kd'))); await wait(20); }
      assert.equal(last().phase, 'reading');
      assert.equal(readings(), 1, 'several admins advanced one question more than once');
      assert.equal(last().questionSeq, seq + 1);
      seq = last().questionSeq;
      assert.ok(await until(() => last().phase === 'buzzWindow'));
      assert.ok(turnsSeen(marks).every((t) => t.length === 0), 'a buzz during the arm delay won');
      if (variant === 'grace-in') await wait(openedAt() + RULES.kdBuzzWindowMs + 100 - Date.now());
      if (variant === 'grace-out') await wait(openedAt() + RULES.kdBuzzWindowMs + RULES.submissionGraceMs + 120 - Date.now());
      await buzzAll();
      await wait(120);
      const turns = turnsSeen(marks);
      if (variant === 'grace-out') {
        assert.ok(turns.every((t) => t.length === 0), 'buzz after grace won');
        assert.equal(last().phase, 'awaitingMark');
        const before = [];
        for (let i = 0; i < 4; i++) before.push(await f.score(i));
        const m0 = A.map((a) => a.seen.length);
        await Promise.all(A.map(async (a) => a.emit('no-answer-kd', { questionSeq: last().questionSeq, playerIndex: -1 })));
        await settle();
        assert.equal(resolvedSince(m0[0]).length, 1);
        assert.equal(rejections(m0), 2);
        for (let i = 0; i < 4; i++) assert.equal(await f.score(i), before[i]);
        continue;
      }
      const flat = turns.map((t) => t.join(','));
      assert.ok(turns.every((t) => t.length === 1), 'exactly one got-turn per client: ' + JSON.stringify(turns));
      assert.equal(new Set(flat).size, 1, 'clients disagree on the winner');
      const winner = turns[0][0];
      assert.equal(last().turnPlayerIndex, winner);
      assert.equal(last().phase, 'answering');
      const gradeSeq = last().questionSeq;
      const before = await f.score(winner);
      const m0 = A.map((a) => a.seen.length);
      const cmd = { questionSeq: gradeSeq, playerIndex: winner };
      const delta = (e) => e.args[0].scoreDelta;

      if (variant === 'same-mark') {
        await Promise.all(A.map(async (a) => a.emit('correct-mark-kd', cmd)));
        await settle();
        assert.equal(resolvedSince(m0[0]).length, 1);
        assert.equal(rejections(m0), 2);
        assert.equal(await f.score(winner), before + 10);
      } else if (variant === 'conflict') {
        const sends = rng.shuffle(['correct-mark-kd', 'correct-mark-kd', 'wrong-mark-kd', 'wrong-mark-kd']);
        await Promise.all(sends.map(async (ev, i) => A[i % 3].emit(ev, cmd)));
        await settle();
        const resolved = resolvedSince(m0[0]);
        assert.equal(resolved.length, 1, 'conflicting marks resolved more than once');
        assert.equal(rejections(m0), 3);
        assert.equal(await f.score(winner), before + delta(resolved[0]));
        assert.equal(resolved[0].args[0].verdict, sends[0].startsWith('correct') ? 'correct' : 'wrong');
      } else if (variant === 'wrong-clamp') {
        await f.setScore(winner, 3);
        await Promise.all(A.map(async (a) => a.emit('wrong-mark-kd', cmd)));
        await settle();
        assert.equal(resolvedSince(m0[0]).length, 1);
        assert.equal(await f.score(winner), 0, 'penalty must clamp at zero');
      } else {
        // undo-race and grace-in grade once, then (undo-race) undo and re-grade race.
        A[0].emit('correct-mark-kd', cmd);
        assert.ok(await until(() => last().phase === 'resolved'));
        if (variant === 'undo-race') {
          const scoreBase = before;
          const m1 = A.map((a) => a.seen.length);
          const r0 = resolvedSince(m0[0]).length;
          const ops = rng.shuffle([
            [A[0], 'undo-mark-kd', undefined], [A[1], 'undo-mark-kd', undefined],
            [A[2], 'wrong-mark-kd', cmd], [A[0], 'correct-mark-kd', cmd],
          ]);
          await Promise.all(ops.map(async ([a, ev, payload]) => a.emit(ev, payload)));
          await settle();
          const regrades = resolvedSince(m0[0]).length - r0;
          const successes = 4 - rejections(m1);
          const undos = successes - regrades;
          assert.ok(undos >= regrades && undos - regrades <= 1, 'undos=' + undos + ' regrades=' + regrades);
          const mark = last().lastMark;
          assert.equal(await f.score(winner), scoreBase + (mark ? mark.scoreDelta : 0));
        }
      }
      expected = null;
    }
    void expected;
  }));

  // ---------------------------------------------------------- clock sockets
  sections.push(check('sockets clock: admins spam start/pause; seq increases, every client converges', async (rng) => {
    const f = await fixture({ rules: { clockStartDelayMs: { KD: 100 } }, admins: 4, players: 2 });
    const [A, P] = [f.admins, f.players];
    await f.call('/api/rounds/kd', 'PATCH', { gamemode: 'S' });
    let reconnected;
    await Promise.all(A.map(async (admin, who) => {
      for (let i = 0; i < 14; i++) {
        await wait(rng.int(0, 70));
        admin.emit(rng.next() < 0.4 ? 'start-clock' : 'play-pause-clock', 1);
        if (who === 0 && i === 6) {
          reconnected = await connect(f.room.token);
        }
      }
    }));
    // Quiet: the last broadcast is terminal and nothing newer has arrived for a while (late emits still in flight).
    const quiet = () => {
      const lastEvent = named(A[0], 'clock-state').filter((e) => e.args[0].id === 'main').at(-1);
      return lastEvent && ['paused', 'expired', 'stopped', 'idle'].includes(lastEvent.args[0].status) && Date.now() - lastEvent.at > 400;
    };
    assert.ok(await until(quiet, 6000), 'clock never settled');
    const logs = [...A, ...P].map((c) => clockViews(c, 'main'));
    logs.forEach((log, i) => checkTimerLog(log, 'client ' + i));
    const sig = (log) => log.map((v) => v.seq + ':' + v.status).join(',');
    for (const log of logs) assert.equal(sig(log), sig(logs[0]), 'clients saw different clock histories');
    const finalView = logs[0].at(-1);
    const late = await connect(f.room.token);
    for (const client of [late, reconnected, P[0]]) {
      const had = named(client, 'live-state').length;
      client.emit('request-live-state');
      assert.ok(await until(() => named(client, 'live-state').length > had), 'no live-state');
      const snap = named(client, 'live-state').at(-1).args[0].timers.main;
      assert.equal(snap.seq, finalView.seq, 'late or reconnecting client disagrees with the last broadcast');
      assert.equal(snap.status, finalView.status);
      assert.equal(snap.remainingMs, finalView.remainingMs);
    }
    const reViews = clockViews(reconnected, 'main');
    for (let i = 1; i < reViews.length; i++) assert.ok(reViews[i].seq > reViews[i - 1].seq);
  }));

  // ------------------------------------------------------ VCNV + scores
  sections.push(check('sockets VCNV: obstacle buzzes and answers keep one record per player; marks sum exactly', async (rng) => {
    const f = await fixture({ rules: { clockStartDelayMs: { VCNV: 0 }, submissionGraceMs: 500 }, admins: 3, players: 4 });
    const [A, P] = [f.admins, f.players];
    await f.position('VCNV_Q');
    const base = await f.round('vcnv');
    const reset = async () => f.call('/api/rounds/vcnv', 'PUT', { ...base, disabledPlayers: [], obstacleBuzzes: [], showResults: false });
    const burst = async (event, payload) => Promise.all(rng.shuffle([...P, ...P, ...P]).map(async (p) => p.emit(event, ...(payload === undefined ? [] : [payload(p)]))));
    const verify = async (label, expectElapsed) => {
      const round = await f.round('vcnv');
      const buzzes = round.obstacleBuzzes;
      assert.equal(buzzes.length, 4, label + ': one buzz per player');
      assert.deepEqual([...buzzes.map((b) => b.playerIndex)].sort(), [0, 1, 2, 3]);
      assert.deepEqual([...round.disabledPlayers].sort(), [0, 1, 2, 3], label + ': disabled list has duplicates or gaps');
      for (let i = 1; i < buzzes.length; i++) {
        const [a, b] = [buzzes[i - 1], buzzes[i]];
        if (a.elapsedMs !== undefined && b.elapsedMs !== undefined) assert.ok(a.elapsedMs <= b.elapsedMs, label + ': not ordered by elapsedMs');
        else assert.ok(a.timestamp <= b.timestamp);
      }
      assert.equal(buzzes.every((b) => b.elapsedMs !== undefined), expectElapsed, label + ': elapsedMs presence');
      const order = buzzes.map((b) => b.playerIndex).join();
      assert.equal((await f.round('vcnv')).obstacleBuzzes.map((b) => b.playerIndex).join(), order, label + ': ordering changed between reads');
    };
    // No clock yet.
    await reset();
    await burst('attempt-cnv-player');
    await settle();
    await verify('before clock', false);
    // Clock running.
    await reset();
    A[0].emit('start-clock', 2);
    assert.ok(await until(() => clockViews(A[0], 'main').some((v) => v.status === 'running')));
    await burst('attempt-cnv-player');
    await settle();
    await verify('running', true);
    // Row answers: running, inside grace, outside grace.
    await reset();
    const answers = async (prefix) => burst('submit-answer-vcnv', (p) => prefix + P.indexOf(p) + '-' + Math.floor(rng.next() * 3));
    const answerOf = async () => (await f.round('vcnv')).playerAnswers.map((a) => a.answer);
    await wait(100);
    await answers('run');
    await settle();
    const running = await answerOf();
    running.forEach((a, i) => assert.ok(a.startsWith('run' + i + '-'), 'running answer ' + a));
    assert.ok(await until(() => clockViews(A[0], 'main').some((v) => v.status === 'expired'), 4000));
    const expiredAt = named(A[0], 'clock-state').find((e) => e.args[0].id === 'main' && e.args[0].status === 'expired').at;
    await answers('grace');
    await settle();
    (await answerOf()).forEach((a, i) => assert.ok(a.startsWith('grace' + i + '-'), 'grace answer ' + a));
    await wait(expiredAt + 500 + 150 - Date.now());
    await answers('late');
    await settle();
    (await answerOf()).forEach((a, i) => assert.ok(a.startsWith('grace' + i + '-'), 'late answer overwrote: ' + a));
    assert.equal((await f.round('vcnv')).playerAnswers.length, 4);
    // Score integrity: concurrent marks from three admins each apply once.
    const before = await Promise.all([0, 1, 2, 3].map((i) => f.score(i)));
    await Promise.all(A.map(async (a) => a.emit('mark-answer-vcnv', [true, false, true, false])));
    await settle();
    assert.deepEqual(await Promise.all([0, 1, 2, 3].map((i) => f.score(i))), [before[0] + 30, before[1], before[2] + 30, before[3]]);
  }));

  // -------------------------------------------------------------- TT
  sections.push(check('sockets TT: answers near the deadline keep one ranked record per player', async (rng) => {
    const f = await fixture({ rules: { clockStartDelayMs: { TT: 0 }, submissionGraceMs: 500 }, admins: 2, players: 4 });
    const [A, P] = [f.admins, f.players];
    await f.position('TT_Q');
    const round = await f.round('tt');
    await f.call('/api/rounds/tt', 'PUT', { ...round, questions: [{ id: 1, question: 'q', answer: 'a', type: 'image' }], activeQuestionIndex: 0 });
    for (let iteration = 0; iteration < 2; iteration++) {
      A[0].emit('clear-answer-tt');
      await settle();
      const marks = A[0].seen.length;
      A[0].emit('start-clock', 1);
      assert.ok(await until(() => A[0].seen.slice(marks).some((e) => e.name === 'clock-state' && e.args[0].id === 'main' && e.args[0].status === 'running')));
      const submit = async (tag) => Promise.all(rng.shuffle([...P, ...P]).map(async (p) => p.emit('player-submit-answer-tangtoc', tag + P.indexOf(p) + '-' + rng.int(0, 2))));
      await wait(rng.int(50, 250));
      await submit('run');
      await settle();
      let answers = (await f.round('tt')).playerAnswers;
      answers.forEach((a, i) => { assert.ok(a.answer.startsWith('run' + i + '-')); assert.ok(a.elapsedMs <= 1000, 'elapsed ' + a.elapsedMs); });
      assert.ok(await until(() => A[0].seen.slice(marks).some((e) => e.name === 'clock-state' && e.args[0].status === 'expired'), 3000));
      const expiredAt = A[0].seen.slice(marks).find((e) => e.name === 'clock-state' && e.args[0].status === 'expired').at;
      await submit('grace');
      await settle();
      answers = (await f.round('tt')).playerAnswers;
      answers.forEach((a, i) => { assert.ok(a.answer.startsWith('grace' + i + '-'), 'grace ' + a.answer); assert.ok(a.elapsedMs >= 1000 && a.elapsedMs <= 1000 + 500 + 100, 'grace elapsed ' + a.elapsedMs); });
      await wait(expiredAt + 500 + 150 - Date.now());
      await submit('late');
      await settle();
      const final = (await f.round('tt')).playerAnswers;
      assert.equal(final.length, 4);
      assert.deepEqual(final.map((a) => a.playerIndex), [0, 1, 2, 3]);
      final.forEach((a, i) => assert.ok(a.answer.startsWith('grace' + i + '-'), 'late answer accepted: ' + a.answer));
      for (const a of final) for (const b of final) if (a.elapsedMs < b.elapsedMs) assert.ok(a.timestamp <= b.timestamp, 'elapsed ranking disagrees with arrival order');
    }
    // Placement points: ties share a rank, independent of record order; one apply per admin event.
    const answers = [100, 100, 200, 300].map((elapsedMs, playerIndex) => ({ playerIndex, answer: 'x', timestamp: elapsedMs, readableTime: '', correct: true, elapsedMs }));
    const current = await f.round('tt');
    await f.call('/api/rounds/tt', 'PUT', { ...current, playerAnswers: rng.shuffle(answers) });
    const before = await Promise.all([0, 1, 2, 3].map((i) => f.score(i)));
    A[1].emit('submit-mark-tangtoc-admin');
    await settle();
    const gained = (await Promise.all([0, 1, 2, 3].map((i) => f.score(i)))).map((s, i) => s - before[i]);
    assert.deepEqual(gained, [40, 40, 20, 10]);
  }));

  // -------------------------------------------------------------- VD
  sections.push(check('sockets VD: one steal winner per window, none after close; scores never negative', async (rng) => {
    const f = await fixture({ rules: { vdStealMs: 600 }, admins: 2, players: 4 });
    const [A, P] = [f.admins, f.players];
    await f.position('VD');
    const everyone = [...A, ...P];
    for (let w = 0; w < 6; w++) {
      const marks = everyone.map((c) => c.seen.length);
      A[w % 2].emit('start-5s-countdown-vd');
      assert.ok(await until(() => named(P[0], 'unlock-button-vd', marks[2]).length > 0));
      await Promise.all(rng.shuffle([...P, ...P]).map(async (p) => p.emit('player-steal-question')));
      await wait(120);
      const steals = everyone.map((c, i) => named(c, 'player-steal-question', marks[i]).map((e) => e.args[0]));
      assert.ok(steals.every((s) => s.length === 1), 'exactly one steal per client: ' + JSON.stringify(steals));
      assert.equal(new Set(steals.map((s) => s[0])).size, 1);
      assert.notEqual(steals[0][0], 0, 'the question owner cannot steal');
      A[0].emit('reset-stealing-player');
      await wait(60);
    }
    // After the window closes nobody can steal.
    const marks = P.map((c) => c.seen.length);
    A[0].emit('reset-stealing-player');
    A[0].emit('start-5s-countdown-vd');
    assert.ok(await until(() => clockViews(A[0], 'vdSteal').at(-1)?.status === 'expired', 2500));
    await Promise.all(P.map(async (p) => p.emit('player-steal-question')));
    await wait(150);
    P.forEach((p, i) => assert.equal(named(p, 'player-steal-question', marks[i]).length, 0, 'steal after the window closed'));
    // Scores: owner (player 0) loses at most what it has.
    await f.setScore(0, 5);
    await f.setScore(1, 0);
    A[0].emit('start-5s-countdown-vd');
    await settle();
    P[1].emit('player-steal-question');
    await wait(100);
    A[0].emit('mark-correct-vd', 1, 20);
    await settle();
    assert.equal(await f.score(1), 20);
    assert.equal(await f.score(0), 0, 'owner loss clamps at zero');
    await f.setScore(2, 3);
    await Promise.all([A[0], A[1]].map(async (a, i) => a.emit('mark-incorrect-vd', 2, 20 + i)));
    await settle();
    assert.equal(await f.score(2), 0, 'penalty clamps at zero under concurrent marks');
  }));

  // -------------------------------------------------------------- CHP
  sections.push(check('sockets CHP: one get-turn winner per attempt, distinct winners, single award', async (rng) => {
    const f = await fixture({ admins: 3, players: 4 });
    const [A, P] = [f.admins, f.players];
    await f.position('CHP');
    const everyone = [...A, ...P];
    A[0].emit('start-timer-chp');
    assert.ok(await until(() => named(P[0], 'unlock-button-chp').length > 0));
    const winners = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const marks = everyone.map((c) => c.seen.length);
      await Promise.all(rng.shuffle([...P, ...P]).map(async (p) => p.emit('get-turn-chp')));
      await wait(120);
      const turns = everyone.map((c, i) => named(c, 'got-turn-chp', marks[i]).map((e) => e.args[0]));
      assert.ok(turns.every((t) => t.length === 1), 'one winner per attempt: ' + JSON.stringify(turns));
      assert.equal(new Set(turns.map((t) => t[0])).size, 1);
      winners.push(turns[0][0]);
      if (attempt < 3) {
        await Promise.all(A.map(async (a) => a.emit('mark-wrong-chp')));
        await wait(120);
      }
    }
    assert.equal(new Set(winners).size, 4, 'a player who already played won again: ' + winners);
    const before = await f.score(winners[3]);
    await Promise.all(A.map(async (a) => a.emit('mark-correct-chp')));
    await settle();
    assert.equal(await f.score(winners[3]), before + 1, 'award applied more than once');
  }));

  // ------------------------------------------------- rooms in parallel
  sections.push(check('sockets rooms in parallel: no event or score leakage between hosted rooms', async (rng) => {
    const ROOMS = 5;
    const RULES = { kdBuzzArmDelayMs: 100, kdBuzzWindowMs: 400, kdDecisionMs: 500, submissionGraceMs: 200, kdTimeUpMode: 'manual' };
    const rooms = await Promise.all(Array.from({ length: ROOMS }, async () => fixture({ rules: RULES, admins: 1, players: 2 })));
    const runs = rooms.map(async (f, r) => {
      const [admin] = f.admins;
      const total = 2 + (r % 3);
      await f.call('/api/rounds/kd', 'PATCH', { gamemode: 'M' });
      admin.emit('start-turn-kd', total);
      await wait(60);
      let seq;
      for (let q = 0; q < total; q++) {
        const from = admin.seen.length;
        admin.emit('broadcast-kd-question', { question: 'room' + r + '-q' + q, answer: 'a', type: 'text' }, seq);
        assert.ok(await until(() => named(admin, 'kd-phase', from).some((e) => e.args[0].phase === 'buzzWindow')));
        await Promise.all(f.players.map(async (p) => p.emit('get-turn-kd')));
        assert.ok(await until(() => named(admin, 'kd-phase', from).some((e) => e.args[0].phase === 'answering')));
        const phase = named(admin, 'kd-phase', from).at(-1).args[0];
        seq = phase.questionSeq;
        admin.emit('correct-mark-kd', { questionSeq: seq, playerIndex: phase.turnPlayerIndex });
        assert.ok(await until(() => named(admin, 'kd-resolved', from).length === 1));
      }
      await wait(150);
      return total;
    });
    const totals = await Promise.all(runs);
    for (let r = 0; r < ROOMS; r++) {
      const f = rooms[r];
      const clients = [...f.admins, ...f.players];
      for (const c of clients) {
        const phaseSeqs = c.seen.filter((e) => e.name === 'kd-phase' && e.args[0].phase !== 'idle').map((e) => e.args[0].questionSeq);
        assert.ok(phaseSeqs.every((s) => s >= 1 && s <= totals[r]), 'room ' + r + ' saw a foreign question seq: ' + phaseSeqs);
        assert.equal(c.seen.filter((e) => e.name === 'kd-resolved').length, totals[r], 'room ' + r + ' resolved count');
        const texts = c.seen.filter((e) => e.name === 'update-kd-question').map((e) => e.args[0].question).filter(Boolean);
        for (const text of texts) assert.ok(text.startsWith('room' + r + '-'), 'room ' + r + ' received ' + text);
        assert.equal(c.seen.filter((e) => e.name === 'player-got-turn-kd').length, totals[r]);
      }
      const match = await f.match();
      assert.equal(match.players.reduce((n, p) => n + p.score, 0), totals[r] * 10, 'room ' + r + ' score total');
    }
  }));

  try {
    await Promise.all(sections);
  } finally {
    for (const socket of open) socket.close();
  }
}
