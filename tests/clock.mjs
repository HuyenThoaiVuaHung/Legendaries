/**
 * Unit tests for the deadline-based countdowns. No server needed.
 * Run: node tests/clock.mjs (after npm run build)
 */
import assert from 'node:assert/strict';
import { Countdown } from '../dist/time/countdown.js';
import { FakeServerTime } from '../dist/time/fake-server-time.js';
import { applyRuleOverrides, DEFAULT_GAME_RULES, loadGameRules } from '../dist/game.rules.js';

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS  clock: ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  clock: ${name} - ${error.message}`);
  }
};

const make = (id = 'main') => {
  const time = new FakeServerTime();
  const views = [];
  const expired = [];
  const countdown = new Countdown(id, time, {
    onChange: (view) => views.push(view),
    onExpire: (owner) => expired.push(owner),
  });
  return { time, countdown, views, expired };
};

test('start then expire fires once', () => {
  const { time, countdown, views, expired } = make();
  countdown.start(1000);
  assert.equal(countdown.status, 'running');
  time.advance(999);
  assert.equal(countdown.status, 'running');
  assert.equal(countdown.remainingMs(), 1);
  time.advance(1);
  assert.equal(countdown.status, 'expired');
  time.advance(5000);
  assert.equal(expired.length, 1);
  assert.deepEqual(views.map((v) => v.status), ['running', 'expired']);
  assert.equal(time.pending(), 0);
});

test('pause and resume keep millisecond precision', () => {
  const { time, countdown } = make();
  countdown.start(10_000);
  time.advance(2_345);
  assert.ok(countdown.pause());
  assert.equal(countdown.remainingMs(), 7_655);
  time.advance(60_000);
  assert.equal(countdown.remainingMs(), 7_655);
  assert.equal(countdown.view().status, 'paused');
  assert.equal(countdown.view().remainingMs, 7_655);
  assert.ok(countdown.resume());
  time.advance(7_654);
  assert.equal(countdown.status, 'running');
  time.advance(1);
  assert.equal(countdown.status, 'expired');
});

test('superseded start replaces the earlier run silently', () => {
  const { time, countdown, expired } = make();
  countdown.start(1000);
  time.advance(500);
  countdown.start(3000);
  time.advance(1000);
  assert.equal(expired.length, 0);
  time.advance(2000);
  assert.equal(expired.length, 1);
});

test('stale callback is ignored after stop', () => {
  const { time, countdown, expired } = make();
  countdown.start(1000);
  assert.ok(countdown.stop());
  time.advance(5000);
  assert.equal(countdown.status, 'stopped');
  assert.equal(expired.length, 0);
  assert.equal(countdown.stop(), false);
});

test('pending start can be cancelled and begins after the delay', () => {
  const { time, countdown, expired } = make();
  countdown.start(1000, { delayMs: 500 });
  assert.equal(countdown.status, 'pending');
  assert.equal(countdown.view().startsAt - countdown.view().serverTime, 500);
  time.advance(500);
  assert.equal(countdown.status, 'running');
  countdown.start(1000, { delayMs: 500 });
  assert.ok(countdown.stop());
  time.advance(5000);
  assert.equal(countdown.status, 'stopped');
  assert.equal(expired.length, 0);
});

test('seq increases on every transition', () => {
  const { time, countdown, views } = make();
  countdown.start(1000, { delayMs: 100 });
  time.advance(100);
  countdown.pause();
  countdown.resume();
  time.advance(1000);
  const seqs = views.map((v) => v.seq);
  assert.ok(seqs.length >= 5);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
});

test('grace window accepts a late answer only after expiry', () => {
  const { time, countdown } = make();
  countdown.start(1000);
  time.advance(1100);
  assert.ok(countdown.acceptsAt(time.mono(), 250));
  time.advance(200);
  assert.equal(countdown.acceptsAt(time.mono(), 250), false);
});

test('activeElapsedMs excludes pauses and grows past the deadline', () => {
  const { time, countdown } = make();
  countdown.start(10_000);
  time.advance(2_000);
  countdown.pause();
  time.advance(30_000);
  assert.equal(countdown.activeElapsedMs(), 2_000);
  countdown.resume();
  time.advance(1_000);
  assert.equal(countdown.activeElapsedMs(), 3_000);
  time.advance(7_000);
  time.advance(100);
  assert.equal(countdown.status, 'expired');
  assert.equal(countdown.activeElapsedMs(), 10_100);
});

test('kdTimeUpMode and buzz tunables validate', () => {
  const rules = loadGameRules();
  assert.equal(rules.kdTimeUpMode, 'manual');
  assert.equal(rules.kdBuzzArmDelayMs, 300);
  assert.equal(rules.kdBuzzWindowMs, 3000);
  assert.deepEqual(applyRuleOverrides(rules, { kdTimeUpMode: 'bogus', kdBuzzWindowMs: 0 }), []);
  assert.deepEqual(applyRuleOverrides(rules, { kdTimeUpMode: 'autoWrong', kdBuzzArmDelayMs: 0 }).sort(), ['kdBuzzArmDelayMs', 'kdTimeUpMode']);
  assert.equal(rules.kdTimeUpMode, 'autoWrong');
});

test('legacy rule keys migrate in loadGameRules', () => {
  const rules = loadGameRules({ kdClockStartDelayMs: 0, kdDecisionTicks: 20, vdStealTicks: 10, decisionTickMs: 50, mainClockTickMs: 500 });
  assert.equal(rules.kdDecisionMs, 1000);
  assert.equal(rules.vdStealMs, 500);
  assert.deepEqual(rules.clockStartDelayMs, { KD: 0, VCNV: 0, TT: 0, VD: 0, CHP: 0 });
  for (const key of ['kdClockStartDelayMs', 'kdDecisionTicks', 'vdStealTicks', 'decisionTickMs', 'mainClockTickMs']) {
    assert.equal(key in rules, false, key);
  }
  assert.equal(loadGameRules().submissionGraceMs, DEFAULT_GAME_RULES.submissionGraceMs);
  const patched = loadGameRules();
  const changed = applyRuleOverrides(patched, { kdClockStartDelayMs: 0, vdStealTicks: 20 });
  assert.equal(patched.clockStartDelayMs.CHP, DEFAULT_GAME_RULES.clockStartDelayMs.CHP);
  assert.equal(patched.clockStartDelayMs.TT, 0);
  assert.equal(patched.vdStealMs, 2000);
  assert.ok(changed.includes('vdStealMs'));
});

console.log(failures === 0 ? 'clock: ALL PASS' : `clock: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
