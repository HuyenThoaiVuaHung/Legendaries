/** Hosted question bank end-to-end checks. Run against a hosted server: node tests/bank.mjs PORT */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { io } from 'socket.io-client';

const base = `http://localhost:${process.argv[2] ?? '8080'}`;
const suffix = randomUUID().slice(0, 8);
const sockets = [];
const rooms = [];
let setPath;
let owner;

async function request(path, status, { method = 'GET', token, body, headers = {} } = {}) {
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const response = await fetch(base + path, { method, headers, body, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, status, `${method} ${path} returned ${response.status}, expected ${status}`);
  if (status === 204) return;
  if (response.headers.get('content-type')?.includes('application/json')) return response.json();
  return Buffer.from(await response.arrayBuffer());
}

function signup(role) {
  return request('/api/accounts', 201, { method: 'POST', body: { username: `${role}_${suffix}`, password: 'bank-test-pass-123' } });
}

function bank(account, suffix = '', status = 200, method = 'GET', body) {
  return request(setPath + suffix, status, { token: account.token, method, body });
}

async function connect(account, setId, tabId) {
  const socket = io(base + '/bank', {
    autoConnect: false, reconnection: false, forceNew: true,
    auth: { token: account.token, setId, tabId },
  });
  sockets.push(socket);
  const initial = once(socket, 'changed', { signal: AbortSignal.timeout(5000) });
  socket.connect();
  await initial;
  return socket;
}

const fields = (question, answer = 'Answer') => ({ question, answer, type: 0, value: 10 });
const reserve = (account, id, tabId, status = 200) =>
  bank(account, '/reservations/' + id, status, 'POST', { tabId });
const save = (account, id, tabId, token, revision, fields, status = 200) =>
  bank(account, '/sections/' + id, status, 'PUT', { tabId, token, revision, fields });
const release = (account, id, tabId, token) =>
  bank(account, '/reservations/' + id, 204, 'DELETE', { tabId, token });

try {
  assert.equal((await request('/api/server', 200)).multiRoom, true);
  owner = await signup('owner');
  const editor = await signup('editor');
  const viewer = await signup('viewer');
  const defaultSet = await request('/api/bank', 201, { token: owner.token, method: 'POST', body: {} });
  const defaultSnap = await request('/api/bank/' + defaultSet.id, 200, { token: owner.token });
  assert.equal(defaultSnap.item.name, 'Bộ câu hỏi mới');
  assert.equal(defaultSnap.settings.matchVersion, 26);
  assert.equal(defaultSnap.settings.players.length, 4);
  assert.equal(defaultSnap.questions.filter((q) => q.pool === 'vcnv').length, 5);
  assert.equal(defaultSnap.questions.filter((q) => q.pool === 'tt').length, 4);
  await request('/api/bank/' + defaultSet.id, 204, { token: owner.token, method: 'DELETE' });
  console.log('PASS default bank creation populates settings and VCNV/TT slots');

  const set = await request('/api/bank', 201, { token: owner.token, method: 'POST', body: { name: 'Shared question set' } });
  setPath = '/api/bank/' + set.id;
  await request(setPath, 401);
  await bank(editor, '', 404);

  const { addedId: first } = await bank(owner, '/questions', 201, 'POST', { pool: 'chp', fields: fields('First') });
  const { addedId: second } = await bank(owner, '/questions', 201, 'POST', { pool: 'chp', fields: fields('Second') });
  const ttIds = [];
  for (let i = 0; i < 2; i++) {
    const { addedId } = await bank(owner, '/questions', 201, 'POST', {
      pool: 'tt',
      fields: { question: `TT ${i + 5}`, answer: `Ans ${i + 5}`, type: i % 2 === 0 ? 1 : 3, value: 40 },
    });
    ttIds.push(addedId);
  }
  assert.equal((await bank(owner)).questions.filter((q) => q.pool === 'tt').length, 6);
  await bank(owner, '/questions', 400, 'POST', {
    pool: 'tt',
    fields: { question: 'TT 7', answer: 'Ans 7', type: 1, value: 40 },
  });
  for (const id of ttIds) await bank(owner, '/questions/' + id, 200, 'DELETE');
  console.log('PASS TT supports up to 6 questions with mixed image/video types');
  await bank(owner, '/members', 200, 'POST', { username: editor.username, access: 'editor' });
  await bank(owner, '/members', 200, 'POST', { username: viewer.username, access: 'viewer' });
  assert.equal((await request('/api/bank', 200, { token: editor.token })).items.find(item => item.id === set.id)?.access, 'editor');
  assert.equal((await bank(viewer)).item.access, 'viewer');
  await reserve(viewer, first, randomUUID(), 403);
  console.log('PASS account sharing and read-only access');

  const ownerTab = randomUUID();
  const editorTab = randomUUID();
  const peer = await connect(editor, set.id, editorTab);
  const reserved = once(peer, 'changed', { signal: AbortSignal.timeout(5000) });
  const firstLease = await reserve(owner, first, ownerTab);
  await reserved;
  const visibleLease = (await bank(editor)).reservations.find(lease => lease.sectionId === first);
  assert.equal(visibleLease?.username, owner.username);
  assert.ok(!('token' in visibleLease));
  await reserve(owner, first, randomUUID(), 409);
  await reserve(editor, first, editorTab, 409);
  await bank(editor, '/questions/' + first, 409, 'DELETE');

  const secondReserved = once(peer, 'changed', { signal: AbortSignal.timeout(5000) });
  const secondLease = await reserve(editor, second, editorTab);
  await secondReserved;
  const change = once(peer, 'changed', { signal: AbortSignal.timeout(5000) });
  await Promise.all([
    save(owner, first, ownerTab, firstLease.token, 0, fields('First edited')),
    save(editor, second, editorTab, secondLease.token, 0, fields('Second edited')),
  ]);
  await change;
  const published = await bank(viewer);
  assert.deepEqual(published.questions.filter(q => q.pool === 'chp').map(q => q.question), ['First edited', 'Second edited']);
  await save(owner, first, ownerTab, firstLease.token, 0, fields('Stale edit'), 409);
  await release(owner, first, ownerTab, firstLease.token);
  await release(editor, second, editorTab, secondLease.token);
  await save(owner, first, ownerTab, firstLease.token, 1, fields('Released edit'), 409);
  console.log('PASS realtime notifications and independent reservations with stale-write protection');

  const settingsLease = await reserve(owner, 'settings', ownerTab);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  for (const [key, value] of Object.entries({ sectionId: 'settings', tabId: ownerTab, token: settingsLease.token, kind: 'misc' })) form.set(key, value);
  form.set('file', new Blob(['<html>Not an image</html>'], { type: 'image/png' }), 'logo.png');
  await bank(owner, '/media', 400, 'POST', form);
  form.set('file', new Blob([png], { type: 'image/png' }), 'logo.html');
  await bank(viewer, '/media', 403, 'POST', form);
  const { name } = await bank(owner, '/media', 201, 'POST', form);
  assert.match(name, /^[\da-f-]+\.png$/i);
  const settings = published.settings;
  settings.uiConfig.miscImageSrcNames.logo = name;
  settings.matchVersion = 25;
  await save(owner, 'settings', ownerTab, settingsLease.token, published.settingsRevision, settings);
  await release(owner, 'settings', ownerTab, settingsLease.token);
  assert.equal((await bank(owner)).settings.matchVersion, 25);
  const mediaPath = setPath + '/media/misc/' + name;
  await request(mediaPath, 401);
  assert.deepEqual(await bank(viewer, '/media/misc/' + name), png);
  if (process.env.BANK_E2E_STORAGE === 'file') {
    const partial = await request(mediaPath, 206, { token: viewer.token, headers: { Range: 'bytes=0-7' } });
    assert.deepEqual(partial, png.subarray(0, 8));
  }

  const room = await request('/api/rooms', 201, { token: owner.token, method: 'POST', body: { bankItemId: set.id } });
  rooms.push(room.token);
  const roomConfig = await request('/api/config', 200, { token: room.token });
  const copiedLogo = roomConfig.ui.brand.logo;
  assert.deepEqual(roomConfig.rules.ttQuestionSeconds, [20, 20, 30, 30]);
  assert.equal(roomConfig.rules.obstacleValueByRevealedCount[0], 60);
  assert.deepEqual(await request(copiedLogo, 200), png);
  const newLease = await reserve(editor, first, editorTab);
  await save(editor, first, editorTab, newLease.token, 1, fields('Library changed again'));
  const roomRound = await request('/api/rounds/chp', 200, { token: room.token });
  assert.deepEqual(roomRound.questions.map(q => q.question), ['First edited', 'Second edited']);

  const saved = await request('/api/rooms/current/save-to-bank', 201, { token: room.token, method: 'POST', body: { name: 'Room copy' } });
  const copyPath = '/api/bank/' + saved.id;
  try {
    const copy = await request(copyPath, 200, { token: owner.token });
    assert.deepEqual(copy.questions.filter(q => q.pool === 'chp').map(q => q.question), ['First edited', 'Second edited']);
    assert.deepEqual(await request(copyPath + '/media/misc/' + name, 200, { token: owner.token }), png);
  } finally {
    await request(copyPath, 204, { token: owner.token, method: 'DELETE' });
  }
  console.log('PASS raw media and room snapshots round-trip through the bank');

  const revoked = once(peer, 'access-revoked', { signal: AbortSignal.timeout(5000) });
  await bank(owner, '/members', 200, 'POST', { username: editor.username, access: null });
  await revoked;
  await bank(editor, '', 404);
  await save(editor, first, editorTab, newLease.token, 2, fields('Revoked edit'), 404);
  assert.deepEqual((await bank(owner)).reservations, []);
  console.log('PASS revocation disconnects editors and clears reservations');

  const recipient = await signup('recipient');
  const search = '/sharing/accounts?q=' + encodeURIComponent(recipient.username.slice(0, 12));
  assert.ok((await bank(owner, search)).includes(recipient.username));
  await bank(viewer, search, 403);
  assert.deepEqual(await bank(owner, '/sharing/accounts?q=re'), []);
  assert.deepEqual((await bank(owner, '/sharing')).link, { mode: 'restricted' });
  const link = await bank(owner, '/sharing/link', 200, 'PUT', { mode: 'link', access: 'editor' });
  assert.equal(link.mode, 'link');
  assert.equal(typeof link.token, 'string');
  assert.deepEqual((await bank(viewer, '/sharing')).link, { mode: 'link', access: 'editor' });
  await request(setPath + '/sharing/open', 401, { method: 'POST', body: { token: link.token } });
  await bank(recipient, '', 404);
  await bank(recipient, '/sharing/open', 404, 'POST', { token: 'x'.repeat(43) });
  await bank(recipient, '/sharing/open', 204, 'POST', { token: link.token });
  assert.equal((await bank(recipient)).item.access, 'editor');
  const linkTab = randomUUID();
  const linkedSocket = await connect(recipient, set.id, linkTab);
  await reserve(recipient, first, linkTab);
  await bank(owner, '/sharing/link', 200, 'PUT', { mode: 'link', access: 'viewer' });
  assert.equal((await bank(recipient)).item.access, 'viewer');
  assert.deepEqual((await bank(owner)).reservations, []);
  await reserve(recipient, first, linkTab, 403);
  const linkRevoked = once(linkedSocket, 'access-revoked', { signal: AbortSignal.timeout(5000) });
  await bank(owner, '/sharing/link', 200, 'PUT', { mode: 'restricted' });
  await linkRevoked;
  await bank(recipient, '', 404);
  await bank(recipient, '/sharing/open', 404, 'POST', { token: link.token });
  assert.equal((await bank(viewer)).item.access, 'viewer');
  assert.ok(!(await request('/api/bank', 200, { token: recipient.token })).items.some(item => item.id === set.id));
  console.log('PASS private account search, authenticated link access, downgrade, and revocation');

  // Export .legion archive from bank set, then import as new set and replace existing set.
  const exportRes = await fetch(base + setPath + '/export-legion', {
    headers: { Authorization: `Bearer ${owner.token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(exportRes.status, 200);
  const archiveBytes = Buffer.from(await exportRes.arrayBuffer());
  assert.ok(archiveBytes.length > 50, 'exported .legion archive should be non-empty');

  const importForm = new FormData();
  importForm.append('file', new Blob([archiveBytes], { type: 'application/zip' }), 'roundtrip.legion');
  const importedRes = await fetch(base + '/api/bank/import-legion', {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.token}` },
    body: importForm,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(importedRes.status, 201);
  const imported = await importedRes.json();
  const importedSnap = await request(`/api/bank/${imported.id}`, 200, { token: owner.token });
  assert.ok(importedSnap.questions.length >= 1, 'imported .legion set should preserve questions');

  const replaceForm = new FormData();
  replaceForm.append('file', new Blob([archiveBytes], { type: 'application/zip' }), 'replace.legion');
  replaceForm.append('replaceId', imported.id);
  const replacedRes = await fetch(base + '/api/bank/import-legion', {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.token}` },
    body: replaceForm,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(replacedRes.status, 200);
  await request(`/api/bank/${imported.id}`, 204, { token: owner.token, method: 'DELETE' });
  console.log('PASS bank .legion export and import (create + replace)');
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const token of rooms) await request('/api/rooms/current', 204, { token, method: 'DELETE' });
  if (setPath) {
    await fetch(base + setPath, { method: 'DELETE', headers: { Authorization: `Bearer ${owner.token}` }, signal: AbortSignal.timeout(5000) });
  }
}
