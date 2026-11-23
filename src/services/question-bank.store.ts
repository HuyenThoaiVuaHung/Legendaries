import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { BankAccess, BankQuestion, EditingLease, MATCH_VERSIONS, MatchVersion, QUESTION_POOLS, QuestionFields, QuestionSet, QuestionSetItem, SetSettings } from '../contracts/bank';
import { EditorData } from './legion-file.service';
import { bankMediaExtension, BankMediaMode, BankMediaStorage, FileBankMediaStorage, readStoredMedia, SqliteBankMediaStorage, StoredMedia } from './bank-media-storage';
import { safeMimeForFileName } from './media-validation';

export class BankError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new BankError(status, message); };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 50000): string => typeof v === 'string' && v.length <= max ? v : fail(400, 'Invalid text');
const finite = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : fail(400, 'Invalid number');
const ID = /^[0-9a-f-]{36}$/i;
const TTL = 45000;
const emptyQuestion = (): QuestionFields => ({ question: '', answer: '', type: 0, value: 10, mediaSrcName: '', secondaryMediaSrcName: '' });

export function questionFields(v: unknown): QuestionFields {
  if (!record(v)) return fail(400, 'Invalid question');
  const type = finite(v['type']);
  if (!Number.isInteger(type) || type < 0 || type > 3) return fail(400, 'Invalid question type');
  return { question: text(v['question']), answer: text(v['answer']), type, value: finite(v['value']),
    mediaSrcName: v['mediaSrcName'] === undefined ? '' : text(v['mediaSrcName'], 255),
    secondaryMediaSrcName: v['secondaryMediaSrcName'] === undefined ? '' : text(v['secondaryMediaSrcName'], 255) };
}
const DEFAULT_SET_NAME = 'Bộ câu hỏi mới';
const DEFAULT_MATCH_VERSION: MatchVersion = 26;
const isMatchVersion = (v: unknown): v is MatchVersion =>
  typeof v === 'number' && (MATCH_VERSIONS as readonly number[]).includes(v);

export function setSettings(v: unknown): SetSettings {
  if (!record(v) || !Array.isArray(v['players']) || !Array.isArray(v['obstacleImages']) || !record(v['uiConfig'])) return fail(400, 'Invalid set settings');
  if (!isMatchVersion(v['matchVersion'])) return fail(400, 'Invalid format');
  if (v['players'].length > 4 || v['obstacleImages'].length > 5) return fail(400, 'Too many players or obstacle images');
  const ui = v['uiConfig'];
  const names = ui['miscImageSrcNames'];
  if (!record(names) || typeof ui['darkMode'] !== 'boolean') return fail(400, 'Invalid appearance');
  const miscImageSrcNames: Record<string, string> = {};
  for (const [key, value] of Object.entries(names)) {
    if (!['logo', 'logo-long', 'background', 'placeholder'].includes(key)) return fail(400, 'Invalid brand slot');
    miscImageSrcNames[key] = text(value, 255);
  }
  return { matchName: text(v['matchName'], 80), matchVersion: v['matchVersion'], players: v['players'].map((p) => text(p, 100)),
    obstacle: text(v['obstacle']), obstacleImages: v['obstacleImages'].map((p) => text(p, 255)),
    uiConfig: { darkMode: ui['darkMode'], pallette: finite(ui['pallette']), miscImageSrcNames } };
}
const defaults = (name: string): SetSettings => ({
  matchName: name,
  matchVersion: DEFAULT_MATCH_VERSION,
  players: ['Nguyễn Văn A', 'Trần Thị B', 'Phạm Văn C', 'Nguyễn Thị D'],
  obstacle: '',
  obstacleImages: ['', '', '', '', ''],
  uiConfig: { darkMode: true, pallette: 10, miscImageSrcNames: {} },
});
const defaultQuestions = (): { pool: string; fields: QuestionFields }[] => [
  ...Array.from({ length: 5 }, () => ({ pool: 'vcnv', fields: { question: '', answer: '', type: 0, value: 10, mediaSrcName: '', secondaryMediaSrcName: '' } })),
  ...Array.from({ length: 4 }, () => ({ pool: 'tt', fields: { question: '', answer: '', type: 1, value: 40, mediaSrcName: '', secondaryMediaSrcName: '' } })),
];

/** Owns set metadata and dispatches media reads to the storage recorded on each file. */
export class QuestionBankStore {
  readonly db: DatabaseSync;
  private readonly mediaStores: Record<BankMediaMode, BankMediaStorage>;
  onChange: (id: string) => void = () => undefined;
  constructor(root: string, readonly maxItems: number, readonly maxBytes: number, private readonly mediaMode: BankMediaMode = 'file', private readonly clock = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'question-bank.sqlite'));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sets(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, pool TEXT NOT NULL, position INTEGER NOT NULL, fields TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS questions_set ON questions(set_id,pool,position);
      CREATE TABLE IF NOT EXISTS members(set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, account_id TEXT NOT NULL, username TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('editor','viewer')), PRIMARY KEY(set_id,account_id));
      CREATE INDEX IF NOT EXISTS members_account ON members(account_id);
      CREATE TABLE IF NOT EXISTS sharing_links(set_id TEXT PRIMARY KEY REFERENCES sets(id) ON DELETE CASCADE, token TEXT NOT NULL, access TEXT NOT NULL CHECK(access IN ('editor','viewer')));
      CREATE TABLE IF NOT EXISTS sharing_grants(set_id TEXT NOT NULL REFERENCES sharing_links(set_id) ON DELETE CASCADE, account_id TEXT NOT NULL, PRIMARY KEY(set_id,account_id));
      CREATE INDEX IF NOT EXISTS sharing_grants_account ON sharing_grants(account_id);
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, UNIQUE(set_id,kind,name));
      CREATE TABLE IF NOT EXISTS reservations(set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, section_id TEXT NOT NULL, account_id TEXT NOT NULL, username TEXT NOT NULL, session_id TEXT NOT NULL, tab_id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(set_id,section_id));`);
    this.transaction(() => {
      const columns = new Set(this.db.prepare('PRAGMA table_info(media)').all().map(column => column['name']));
      if (!columns.has('storage')) this.db.exec("ALTER TABLE media ADD COLUMN storage TEXT NOT NULL DEFAULT 'sqlite' CHECK(storage IN ('file','sqlite'))");
      if (!columns.has('size_bytes')) {
        this.db.exec('ALTER TABLE media ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0; UPDATE media SET size_bytes=length(data)');
      }
      this.db.exec('PRAGMA user_version=3');
    });
    this.mediaStores = { file: new FileBankMediaStorage(join(root, 'media')), sqlite: new SqliteBankMediaStorage(this.db) };
    this.db.exec('DELETE FROM reservations');
  }
  close(): void { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = work(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private mediaTransaction(work: (media: { id: string; bytes: Buffer }[]) => void): void {
    const stored: string[] = [];
    try {
      this.transaction(() => {
        const media: { id: string; bytes: Buffer }[] = [];
        work(media);
        for (const { id, bytes } of media) {
          this.mediaStores[this.mediaMode].write(id, bytes);
          stored.push(id);
        }
      });
    } catch (error) {
      this.removeFiles(stored.map(id => ({ id, storage: this.mediaMode })));
      throw error;
    }
  }
  access(id: string, accountId: string, editing = false): BankAccess {
    const row = this.db.prepare('SELECT owner_id FROM sets WHERE id=?').get(id);
    if (!row) return fail(404, 'Question set not found');
    if (row['owner_id'] === accountId) return 'owner';
    const member = this.db.prepare('SELECT access FROM members WHERE set_id=? AND account_id=?').get(id, accountId)
      ?? this.db.prepare('SELECT l.access FROM sharing_grants g JOIN sharing_links l USING(set_id) WHERE g.set_id=? AND g.account_id=?').get(id, accountId);
    if (!member || (member['access'] !== 'editor' && member['access'] !== 'viewer')) return fail(404, 'Question set not found');
    if (editing && member['access'] === 'viewer') return fail(403, 'View-only access');
    return member['access'];
  }
  link(id: string, accountId: string) {
    const role = this.access(id, accountId);
    const row = this.db.prepare('SELECT token,access FROM sharing_links WHERE set_id=?').get(id);
    if (!row) return { mode: 'restricted' as const };
    const access = row['access'] === 'editor' ? 'editor' as const : 'viewer' as const;
    return { mode: 'link' as const, access, ...(role === 'owner' ? { token: String(row['token']) } : {}) };
  }
  setLink(id: string, accountId: string, mode: unknown, access: unknown): void {
    if (this.access(id, accountId) !== 'owner') return fail(403, 'Only the owner can manage sharing');
    if (mode !== 'restricted' && (mode !== 'link' || (access !== 'viewer' && access !== 'editor'))) return fail(400, 'Invalid link access');
    this.transaction(() => {
      if (mode === 'restricted' || access === 'viewer') {
        this.db.prepare(`DELETE FROM reservations WHERE set_id=? AND account_id IN
          (SELECT account_id FROM sharing_grants WHERE set_id=? EXCEPT SELECT account_id FROM members WHERE set_id=? AND access='editor')`)
          .run(id, id, id);
      }
      if (mode === 'restricted') this.db.prepare('DELETE FROM sharing_links WHERE set_id=?').run(id);
      else this.db.prepare('INSERT INTO sharing_links VALUES(?,?,?) ON CONFLICT(set_id) DO UPDATE SET access=excluded.access')
        .run(id, randomBytes(32).toString('base64url'), String(access));
    });
    this.onChange(id);
  }
  openLink(id: string, accountId: string, raw: unknown): void {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return fail(404, 'Invite link not found');
    const row = this.db.prepare('SELECT token FROM sharing_links WHERE set_id=?').get(id);
    if (typeof row?.['token'] !== 'string' || !timingSafeEqual(Buffer.from(raw), Buffer.from(row['token']))) return fail(404, 'Invite link not found');
    const set = this.db.prepare('SELECT owner_id FROM sets WHERE id=?').get(id);
    if (set?.['owner_id'] !== accountId) {
      this.db.prepare('INSERT OR IGNORE INTO sharing_grants VALUES(?,?)').run(id, accountId);
    }
  }
  usage(accountId: string): number {
    return Number(this.db.prepare(`SELECT COALESCE(SUM(length(s.settings)+length(s.name)),0)+
      (SELECT COALESCE(SUM(length(q.fields)),0) FROM questions q JOIN sets s ON s.id=q.set_id WHERE s.owner_id=?)+
      (SELECT COALESCE(SUM(m.size_bytes),0) FROM media m JOIN sets s ON s.id=m.set_id WHERE s.owner_id=?) bytes
      FROM sets s WHERE s.owner_id=?`).get(accountId, accountId, accountId)?.['bytes'] ?? 0);
  }
  private quota(ownerId: string): void { if (this.usage(ownerId) > this.maxBytes) fail(413, 'Question bank storage is full'); }
  list(accountId: string): QuestionSetItem[] {
    return this.db.prepare(`SELECT s.id FROM sets s WHERE s.owner_id=?
      OR EXISTS (SELECT 1 FROM members m WHERE m.set_id=s.id AND m.account_id=?)
      OR EXISTS (SELECT 1 FROM sharing_grants g WHERE g.set_id=s.id AND g.account_id=?)
      ORDER BY s.updated_at DESC`).all(accountId, accountId, accountId)
      .map((r) => this.item(String(r['id']), accountId));
  }
  item(id: string, accountId: string): QuestionSetItem {
    const access = this.access(id, accountId);
    const row = this.db.prepare(`SELECT s.*, length(s.settings)+(SELECT COALESCE(SUM(length(fields)),0) FROM questions WHERE set_id=s.id)+(SELECT COALESCE(SUM(size_bytes),0) FROM media WHERE set_id=s.id) bytes FROM sets s WHERE id=?`).get(id)!;
    const settings: SetSettings = JSON.parse(String(row['settings']));
    return { id, name: String(row['name']), matchName: settings.matchName, ownerId: String(row['owner_id']), access,
      sizeBytes: Number(row['bytes']), createdAt: Number(row['created_at']), updatedAt: Number(row['updated_at']) };
  }
  create(accountId: string, rawName: unknown, settings?: SetSettings, questions?: { pool: string; fields: QuestionFields }[], files: { folder: string; name: string; data: Buffer }[] = [], replaceId?: string): QuestionSetItem {
    const name = rawName === undefined ? DEFAULT_SET_NAME : text(rawName, 80).trim();
    if (!name) return fail(400, 'Enter a name');
    const initialQuestions = questions ?? defaultQuestions();
    const id = replaceId ?? randomUUID();
    if (replaceId) {
      if (this.access(id, accountId) !== 'owner') return fail(403, 'Only the owner can replace this set');
      this.assertIdle(id);
    }
    const oldFiles = replaceId ? this.mediaIds(id) : [];
    this.mediaTransaction((written) => {
      const count = Number(this.db.prepare('SELECT COUNT(*) n FROM sets WHERE owner_id=?').get(accountId)?.['n']);
      if (!replaceId && count >= this.maxItems) fail(413, 'Question bank item limit reached');
      if (replaceId) {
        this.db.prepare('DELETE FROM questions WHERE set_id=?').run(id);
        this.db.prepare('DELETE FROM media WHERE set_id=?').run(id);
        this.db.prepare('UPDATE sets SET settings=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(settings ?? defaults(name)), this.clock(), id);
      } else this.db.prepare('INSERT INTO sets(id,owner_id,name,settings,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, accountId, name, JSON.stringify(settings ?? defaults(name)), this.clock(), this.clock());
      const positions = new Map<string, number>();
      for (const q of initialQuestions) {
        const position = positions.get(q.pool) ?? 0;
        this.insertQuestion(id, q.pool, position, q.fields);
        positions.set(q.pool, position + 1);
      }
      for (const file of files) {
        const mime = safeMimeForFileName(file.name) ?? 'application/octet-stream';
        const mediaId = this.addMedia(id, file.folder, file.name, mime, file.data.length);
        if (mediaId) written.push({ id: mediaId, bytes: file.data });
      }
      this.quota(accountId);
    });
    this.removeFiles(oldFiles);
    this.onChange(id);
    return this.item(id, accountId);
  }
  snapshot(id: string, accountId: string): QuestionSet {
    const item = this.item(id, accountId);
    const row = this.db.prepare('SELECT settings,revision FROM sets WHERE id=?').get(id)!;
    const settings: SetSettings = JSON.parse(String(row['settings']));
    const questions = this.db.prepare('SELECT * FROM questions WHERE set_id=? ORDER BY pool,position,id').all(id).map((q): BankQuestion => ({
      ...questionFields(JSON.parse(String(q['fields']))), id: String(q['id']), pool: String(q['pool']), position: Number(q['position']), revision: Number(q['revision']),
    }));
    return { item, settings, settingsRevision: Number(row['revision']), questions,
      members: item.access === 'viewer'
        ? []
        : this.db.prepare('SELECT * FROM members WHERE set_id=?').all(id).map((m) => ({ accountId: String(m['account_id']), username: String(m['username']), access: m['access'] === 'editor' ? 'editor' : 'viewer' })),
      reservations: this.leases(id) };
  }
  share(id: string, ownerId: string, accountId: string, username: string, access: unknown): void {
    if (this.access(id, ownerId) !== 'owner') return fail(403, 'Only the owner can share this set');
    if (accountId === ownerId) return fail(400, 'The owner already has access');
    if (access !== 'editor' && access !== 'viewer' && access !== null) return fail(400, 'Invalid access');
    this.transaction(() => {
      if (access === null) this.db.prepare('DELETE FROM members WHERE set_id=? AND account_id=?').run(id, accountId);
      else this.db.prepare('INSERT INTO members VALUES(?,?,?,?) ON CONFLICT(set_id,account_id) DO UPDATE SET access=excluded.access').run(id, accountId, username, access);
      this.db.prepare('DELETE FROM reservations WHERE set_id=? AND account_id=?').run(id, accountId);
    });
    this.onChange(id);
  }
  reserve(id: string, accountId: string, username: string, sessionId: string, tabId: string, sectionId: string): EditingLease {
    this.access(id, accountId, true);
    if (!ID.test(tabId)) return fail(400, 'Invalid browser tab');
    if (sectionId !== 'settings' && !this.db.prepare('SELECT id FROM questions WHERE set_id=? AND id=?').get(id, sectionId)) return fail(404, 'Question not found');
    const lease = this.transaction(() => {
      this.expire();
      const held = this.db.prepare('SELECT * FROM reservations WHERE set_id=? AND section_id=?').get(id, sectionId);
      if (held && (held['session_id'] !== sessionId || held['tab_id'] !== tabId)) return fail(409, `${held['username']} is editing this question`);
      const token = held ? String(held['token']) : randomUUID();
      const expiresAt = this.clock() + TTL;
      this.db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(set_id,section_id) DO UPDATE SET expires_at=excluded.expires_at').run(id, sectionId, accountId, username, sessionId, tabId, token, expiresAt);
      return { token, expiresAt };
    });
    this.onChange(id);
    return lease;
  }
  renew(id: string, accountId: string, sessionId: string, tabId: string, sectionId: string, token: string): EditingLease {
    this.access(id, accountId, true);
    this.held(id, sessionId, tabId, sectionId, token);
    const expiresAt = this.clock() + TTL;
    this.db.prepare('UPDATE reservations SET expires_at=? WHERE set_id=? AND section_id=?').run(expiresAt, id, sectionId);
    return { token, expiresAt };
  }
  release(id: string, accountId: string, sessionId: string, tabId: string, sectionId: string, token: string): void {
    this.access(id, accountId, true);
    this.held(id, sessionId, tabId, sectionId, token);
    this.db.prepare('DELETE FROM reservations WHERE set_id=? AND section_id=?').run(id, sectionId);
    this.onChange(id);
  }
  save(id: string, accountId: string, sessionId: string, tabId: string, sectionId: string, token: string, revision: number, raw: unknown): void {
    this.access(id, accountId, true);
    this.transaction(() => {
      this.held(id, sessionId, tabId, sectionId, token);
      let changed: number | bigint;
      if (sectionId === 'settings') {
        const settings = setSettings(raw);
        this.validateReferences(id, settings.obstacleImages.map((name) => ({ name, kind: 'vcnv' })).concat(Object.values(settings.uiConfig.miscImageSrcNames).map((name) => ({ name, kind: 'misc' }))));
        const old: SetSettings = JSON.parse(String(this.db.prepare('SELECT settings FROM sets WHERE id=?').get(id)!['settings']));
        if ((old.matchVersion === 23) !== (settings.matchVersion === 23)) {
          this.expire();
          const lockedKd = this.db.prepare(
            "SELECT username FROM reservations WHERE set_id=? AND section_id IN (SELECT id FROM questions WHERE set_id=? AND pool LIKE 'kd-%') AND NOT (session_id=? AND tab_id=?)",
          ).get(id, id, sessionId, tabId);
          if (lockedKd) return fail(409, `${lockedKd['username']} is editing a Warm-up question. Wait for them to finish.`);
          this.db.prepare("DELETE FROM reservations WHERE set_id=? AND section_id IN (SELECT id FROM questions WHERE set_id=? AND pool LIKE 'kd-%')").run(id, id);
          this.db.prepare("DELETE FROM questions WHERE set_id=? AND pool LIKE 'kd-%'").run(id);
        }
        changed = this.db.prepare('UPDATE sets SET settings=?,revision=revision+1 WHERE id=? AND revision=?').run(JSON.stringify(settings), id, revision).changes;
      } else {
        const fields = questionFields(raw);
        const q = this.db.prepare('SELECT pool FROM questions WHERE id=? AND set_id=?').get(sectionId, id);
        if (!q) return fail(404, 'Question not found');
        const kind = String(q['pool']).split('-')[0];
        this.validateReferences(id, [fields.mediaSrcName, fields.secondaryMediaSrcName].map((name) => ({ name, kind })));
        changed = this.db.prepare('UPDATE questions SET fields=?,revision=revision+1 WHERE id=? AND set_id=? AND revision=?').run(JSON.stringify(fields), sectionId, id, revision).changes;
      }
      if (!changed) return fail(409, 'Content changed. Reload before saving.');
      this.touch(id);
      this.quota(this.item(id, accountId).ownerId);
    });
    this.onChange(id);
  }
  addQuestion(id: string, accountId: string, pool: string, raw?: unknown, requestedPosition?: unknown): string {
    this.access(id, accountId, true);
    const addedId = this.transaction(() => {
      const count = Number(this.db.prepare('SELECT COUNT(*) n FROM questions WHERE set_id=?').get(id)?.['n']);
      if (count >= 2000) fail(413, 'Question limit reached');
      const nextPosition = Number(this.db.prepare('SELECT COALESCE(MAX(position),-1)+1 n FROM questions WHERE set_id=? AND pool=?').get(id, pool)?.['n']);
      const limit = pool === 'tt' ? 6 : pool === 'vcnv' ? 5 : undefined;
      if (requestedPosition !== undefined && (limit === undefined || typeof requestedPosition !== 'number' || !Number.isInteger(requestedPosition) || requestedPosition < 0 || requestedPosition >= limit)) return fail(400, 'Invalid question position');
      const position = typeof requestedPosition === 'number' ? requestedPosition : nextPosition;
      if (limit !== undefined && position >= limit) return fail(400, 'Question pool is full');
      if (this.db.prepare('SELECT 1 FROM questions WHERE set_id=? AND pool=? AND position=?').get(id, pool, position)) return fail(409, 'This question slot already exists');
      const fields = raw === undefined ? emptyQuestion() : questionFields(raw);
      if (fields.mediaSrcName || fields.secondaryMediaSrcName) return fail(400, 'Attach media after creating the question');
      const questionId = this.insertQuestion(id, pool, position, fields);
      this.quota(this.item(id, accountId).ownerId);
      this.touch(id);
      return questionId;
    });
    this.onChange(id);
    return addedId;
  }
  deleteQuestion(id: string, accountId: string, questionId: string): void {
    this.access(id, accountId, true);
    this.transaction(() => {
      this.expire();
      if (this.db.prepare('SELECT 1 FROM reservations WHERE set_id=? AND section_id=?').get(id, questionId)) fail(409, 'Finish editing before deleting this question');
      if (!this.db.prepare('DELETE FROM questions WHERE id=? AND set_id=?').run(questionId, id).changes) fail(404, 'Question not found');
      this.touch(id);
    });
    this.onChange(id);
  }
  reorder(id: string, accountId: string, pool: string, ids: unknown): void {
    this.access(id, accountId, true);
    if (!Array.isArray(ids) || !ids.every((entry): entry is string => typeof entry === 'string')) return fail(400, 'Invalid question order');
    this.transaction(() => {
      this.assertIdle(id);
      const rows = this.db.prepare('SELECT id FROM questions WHERE set_id=? AND pool=?').all(id, pool);
      const valid = new Set(rows.map(row => row['id']));
      if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(entry => !valid.has(entry))) return fail(409, 'Questions changed. Refresh and try again.');
      const update = this.db.prepare('UPDATE questions SET position=? WHERE set_id=? AND id=?');
      ids.forEach((entry, index) => update.run(index, id, entry));
      this.touch(id);
    });
    this.onChange(id);
  }
  rename(id: string, accountId: string, raw: unknown): QuestionSetItem {
    if (this.access(id, accountId) !== 'owner') return fail(403, 'Only the owner can rename this set');
    const name = text(raw, 80).trim();
    if (!name) return fail(400, 'Enter a name');
    this.db.prepare('UPDATE sets SET name=?,updated_at=? WHERE id=?').run(name, this.clock(), id);
    this.onChange(id);
    return this.item(id, accountId);
  }
  remove(id: string, accountId: string): void {
    if (this.access(id, accountId) !== 'owner') return fail(403, 'Only the owner can delete this set');
    this.assertIdle(id);
    const files = this.mediaIds(id);
    this.db.prepare('DELETE FROM sets WHERE id=?').run(id);
    this.removeFiles(files);
    this.onChange(id);
  }
  assertIdle(id: string): void { if (this.leases(id).length) fail(409, 'Someone is editing this set. Wait for them to finish.'); }
  leases(id: string) {
    this.expire();
    return this.db.prepare('SELECT * FROM reservations WHERE set_id=?').all(id).map((r) => ({ sectionId: String(r['section_id']), username: String(r['username']), tabId: String(r['tab_id']), expiresAt: Number(r['expires_at']) }));
  }
  private expire(): void { this.db.prepare('DELETE FROM reservations WHERE expires_at<=?').run(this.clock()); }
  private held(id: string, sessionId: string, tabId: string, sectionId: string, token: string): void {
    const row = this.db.prepare('SELECT 1 FROM reservations WHERE set_id=? AND section_id=? AND session_id=? AND tab_id=? AND token=? AND expires_at>?').get(id, sectionId, sessionId, tabId, token, this.clock());
    if (!row) fail(409, 'Editing reservation expired. Your browser recovery copy is retained.');
  }
  private insertQuestion(id: string, pool: string, position: number, fields: QuestionFields): string {
    if (!QUESTION_POOLS.some((p) => p.id === pool)) return fail(400, 'Unknown question pool');
    const questionId = randomUUID();
    this.db.prepare('INSERT INTO questions(id,set_id,pool,position,fields) VALUES(?,?,?,?,?)').run(questionId, id, pool, position, JSON.stringify(fields));
    return questionId;
  }
  private touch(id: string): void { this.db.prepare('UPDATE sets SET updated_at=? WHERE id=?').run(this.clock(), id); }
  private validateReferences(id: string, refs: { kind: string; name: string }[]): void {
    for (const { kind, name } of refs) if (name && !this.db.prepare('SELECT 1 FROM media WHERE set_id=? AND kind=? AND name=?').get(id, kind, name)) fail(400, 'Upload the referenced media first');
  }
  private addMedia(setId: string, kind: string, name: string, mime: string, size: number): string | undefined {
    const id = randomUUID();
    const result = this.db.prepare(
      "INSERT INTO media(id,set_id,kind,name,mime,data,storage,size_bytes) VALUES(?,?,?,?,?,X'',?,?) ON CONFLICT(set_id,kind,name) DO NOTHING",
    ).run(id, setId, kind, name, mime, this.mediaMode, size);
    return result.changes ? id : undefined;
  }
  private mediaIds(setId: string): { id: string; storage: BankMediaMode }[] {
    return this.db.prepare('SELECT id,storage FROM media WHERE set_id=?').all(setId)
      .map(row => ({ id: String(row['id']), storage: row['storage'] === 'file' ? 'file' : 'sqlite' }));
  }
  private removeFiles(files: { id: string; storage: BankMediaMode }[]): void {
    for (const { id, storage } of files) {
      try { this.mediaStores[storage].remove(id); }
      catch { console.warn('Could not remove bank media', id); }
    }
  }
  upload(id: string, accountId: string, sessionId: string, tabId: string, sectionId: string, token: string, kind: string, mime: string, bytes: Buffer): string {
    this.access(id, accountId, true);
    if (!['kd', 'vcnv', 'tt', 'vd', 'chp', 'misc'].includes(kind)) return fail(400, 'Unknown media kind');
    const extension = bankMediaExtension(mime, bytes);
    if (!extension) return fail(400, 'Unsupported media type or file content');
    const name = `${randomUUID()}.${extension}`;
    this.mediaTransaction(written => {
      this.held(id, sessionId, tabId, sectionId, token);
      if (sectionId === 'settings') {
        if (kind !== 'misc' && kind !== 'vcnv') fail(400, 'Invalid media kind for settings');
      } else {
        const question = this.db.prepare('SELECT pool FROM questions WHERE set_id=? AND id=?').get(id, sectionId);
        if (!question || String(question['pool']).split('-')[0] !== kind) fail(400, 'Invalid media kind for this question');
      }
      const mediaId = this.addMedia(id, kind, name, mime, bytes.length);
      if (!mediaId) throw new Error('Duplicate media name');
      this.quota(this.item(id, accountId).ownerId);
      written.push({ id: mediaId, bytes });
    });
    return name;
  }
  media(id: string, accountId: string, kind: string, name: string): { content: StoredMedia; mime: string } {
    this.access(id, accountId);
    const row = this.db.prepare('SELECT id,storage,mime FROM media WHERE set_id=? AND kind=? AND name=?').get(id, kind, name);
    if (!row) return fail(404, 'Media not found');
    return { content: this.mediaStores[row['storage'] === 'file' ? 'file' : 'sqlite'].open(String(row['id'])), mime: String(row['mime']) };
  }
  files(id: string, accountId: string, maxBytes = Infinity): { folder: 'kd' | 'vcnv' | 'tt' | 'vd' | 'chp' | 'misc'; name: string; data: Buffer }[] {
    this.access(id, accountId);
    const rows = this.db.prepare('SELECT id,storage,kind,name,size_bytes FROM media WHERE set_id=?').all(id);
    if (rows.reduce((total, row) => total + Number(row['size_bytes']), 0) > maxBytes) return fail(413, 'Room storage is full');
    return rows.map((r) => {
      const folder = r['kind'];
      if (folder !== 'kd' && folder !== 'vcnv' && folder !== 'tt' && folder !== 'vd' && folder !== 'chp' && folder !== 'misc') throw new Error('Invalid stored media kind');
      const content = this.mediaStores[r['storage'] === 'file' ? 'file' : 'sqlite'].open(String(r['id']));
      return { folder, name: String(r['name']), data: readStoredMedia(content) };
    });
  }
  editorData(id: string, accountId: string): EditorData {
    const doc = this.snapshot(id, accountId);
    const pool = (name: string) => doc.questions.filter((q) => q.pool === name).map(({ question, answer, type, value, mediaSrcName, secondaryMediaSrcName }) => ({ question, answer, type, value, mediaSrcName, secondaryMediaSrcName }));
    return { uid: id, dateModified: doc.item.updatedAt, uiConfig: doc.settings.uiConfig,
      matchData: { matchName: doc.settings.matchName, matchVersion: doc.settings.matchVersion, matchPos: 0, players: doc.settings.players.map((name) => ({ name, score: 0, isReady: false })) },
      questionBank: { kd: doc.settings.matchVersion === 23 ? { o23Questions: [0,1,2].map((i) => pool(`kd-single-${i}`)) } : { o24Questions: { multiplayer: pool('kd-multi'), singleplayer: [0,1,2,3].map((i) => pool(`kd-single-${i}`)) } },
        vcnv: { cnv: doc.settings.obstacle, cnvMediaSrcNames: doc.settings.obstacleImages, questions: pool('vcnv') }, tt: { questions: pool('tt') }, vd: { questions: [0,1,2,3].map((i) => pool(`vd-${i}`)) }, chp: { questions: pool('chp') } } };
  }
  importData(accountId: string, raw: unknown, files: { folder: string; name: string; data: Buffer }[] = [], replaceId?: string): QuestionSetItem {
    if (!record(raw) || !record(raw['matchData']) || !record(raw['questionBank'])) return fail(400, 'Expected structured editor data');
    const match = raw['matchData'];
    const bank = raw['questionBank'];
    const ui = record(raw['uiConfig']) ? raw['uiConfig'] : defaults('').uiConfig;
    const rawMisc = record(ui['miscImageSrcNames']) ? ui['miscImageSrcNames'] : {};
    const miscImageSrcNames: Record<string, string> = {};
    for (const slot of ['logo', 'logo-long', 'background', 'placeholder']) {
      if (typeof rawMisc[slot] === 'string' && rawMisc[slot]) miscImageSrcNames[slot] = rawMisc[slot];
    }
    const rawName = typeof match['matchName'] === 'string' ? match['matchName'].trim() : '';
    const matchName = (rawName || 'Bộ câu hỏi đã nhập').slice(0, 80);
    const matchVersion: MatchVersion = isMatchVersion(match['matchVersion']) ? match['matchVersion'] : DEFAULT_MATCH_VERSION;
    const obstacle = record(bank['vcnv']) ? bank['vcnv'] : {};
    const settings = setSettings({ matchName, matchVersion, players: Array.isArray(match['players']) ? match['players'].slice(0, 4).map((p: unknown) => record(p) ? String(p['name'] ?? '') : '') : [],
      obstacle: typeof obstacle['cnv'] === 'string' ? obstacle['cnv'] : '', obstacleImages: Array.isArray(obstacle['cnvMediaSrcNames']) ? obstacle['cnvMediaSrcNames'].slice(0, 5).map((p: unknown) => String(p ?? '')) : [], uiConfig: { darkMode: typeof ui['darkMode'] === 'boolean' ? ui['darkMode'] : true, pallette: typeof ui['pallette'] === 'number' && Number.isFinite(ui['pallette']) ? ui['pallette'] : 10, miscImageSrcNames } });
    const questions: { pool: string; fields: QuestionFields }[] = [];
    const add = (pool: string, values: unknown): void => {
      if (values === undefined) return;
      if (!Array.isArray(values)) return fail(400, 'Invalid question pool');
      for (const q of values) {
        if (!record(q)) return fail(400, 'Invalid question');
        questions.push({
          pool,
          fields: questionFields({
            question: typeof q['question'] === 'string' ? q['question'] : '',
            answer: typeof q['answer'] === 'string' ? q['answer'] : '',
            type: typeof q['type'] === 'number' && Number.isInteger(q['type']) ? q['type'] : 0,
            value: typeof q['value'] === 'number' && Number.isFinite(q['value']) ? q['value'] : 0,
            mediaSrcName: typeof q['mediaSrcName'] === 'string' ? q['mediaSrcName'] : '',
            secondaryMediaSrcName: typeof q['secondaryMediaSrcName'] === 'string' ? q['secondaryMediaSrcName'] : '',
          }),
        });
      }
    };
    const kd = record(bank['kd']) ? bank['kd'] : {};
    const o24 = record(kd['o24Questions']) ? kd['o24Questions'] : {};
    const singles = kd['o23Questions'] ?? o24['singleplayer'];
    if (singles !== undefined) {
      if (!Array.isArray(singles) || singles.length > 4) return fail(400, 'Invalid player pools');
      singles.forEach((pool, i) => add(`kd-single-${i}`, pool));
    }
    add('kd-multi', o24['multiplayer']);
    for (const kind of ['vcnv','tt','chp']) { const round = bank[kind]; if (record(round)) add(kind, round['questions']); }
    const vd = bank['vd'];
    if (record(vd) && vd['questions'] !== undefined) {
      if (!Array.isArray(vd['questions']) || vd['questions'].length > 4) return fail(400, 'Invalid finishing pools');
      vd['questions'].forEach((pool, i) => add(`vd-${i}`, pool));
    }
    if (questions.length > 2000) return fail(413, 'Question limit reached');
    // Local media is uploaded separately as ordinary files after creating the set.
    return this.create(accountId, settings.matchName, settings, questions, files, replaceId);
  }
}
