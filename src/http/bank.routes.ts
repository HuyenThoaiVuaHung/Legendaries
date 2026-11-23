import AdmZip from 'adm-zip';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { BankError, QuestionBankStore } from '../services/question-bank.store';
import { ArchiveBusyError, ArchiveLimitError, parseArchiveAsync, UnsupportedMediaError } from '../services/legion-file.service';
import { validateMediaFile } from '../services/media-validation';
import { accountOf, param, requireAccount } from './middleware';
import type { ApiDeps } from './index';
import { registerBankSockets } from '../sockets/bank';

export function bankError(res: Response, error: unknown): void {
  if (error instanceof BankError) res.status(error.status).json({ error: error.message });
  else res.status(500).json({ error: 'Could not save question set' });
}
const string = (v: unknown): string => {
  if (typeof v !== 'string') throw new BankError(400, 'Invalid editing request');
  return v;
};

export function createBankRoutes(deps: ApiDeps, bank: QuestionBankStore): Router {
  registerBankSockets(deps, bank);
  const router = Router();
  router.use('/api/bank', requireAccount(deps.auth));
  const handle = (work: (req: Request, res: Response) => void) => (req: Request, res: Response): void => {
    try { work(req, res); } catch (error) { bankError(res, error); }
  };
  router.get('/api/bank', handle((req, res) => {
    const { accountId } = accountOf(req);
    res.json({ items: bank.list(accountId), usedBytes: bank.usage(accountId), maxBytes: bank.maxBytes, maxItems: bank.maxItems });
  }));
  router.post('/api/bank', handle((req, res) => {
    const { accountId } = accountOf(req);
    const replaceId = typeof req.body?.replaceId === 'string' && req.body.replaceId.trim() ? req.body.replaceId.trim() : undefined;
    const item = req.body?.editorData === undefined
      ? bank.create(accountId, req.body?.name)
      : bank.importData(accountId, req.body.editorData, [], replaceId);
    res.status(replaceId ? 200 : 201).json(item);
  }));
  const archiveUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.config.uploadLimitBytes, files: 1, fields: 2, fieldSize: 256, parts: 4 },
  });
  router.post('/api/bank/import-legion', (req, res) => {
    archiveUpload.single('file')(req, res, async (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File exceeds upload limit' });
        } else {
          res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid upload' });
        }
        return;
      }
      try {
        if (!req.file) throw new BankError(400, 'Choose a .legion file');
        const { accountId } = accountOf(req);
        const replaceId = typeof req.body?.replaceId === 'string' && req.body.replaceId.trim() ? req.body.replaceId.trim() : undefined;
        if (replaceId && bank.access(replaceId, accountId) !== 'owner') {
          throw new BankError(403, 'Only the owner can replace this set');
        }
        const { editorData, files } = await parseArchiveAsync(req.file.buffer, { maxMediaBytes: bank.maxBytes });
        for (const file of files) {
          if (!validateMediaFile(file.name, file.data)) {
            throw new UnsupportedMediaError(`Unsupported or invalid media file: ${file.name}`);
          }
        }
        const item = bank.importData(accountId, editorData, files, replaceId);
        res.status(replaceId ? 200 : 201).json(item);
      } catch (importErr) {
        if (importErr instanceof ArchiveLimitError) { res.status(413).json({ error: importErr.message }); return; }
        if (importErr instanceof UnsupportedMediaError) { res.status(415).json({ error: importErr.message }); return; }
        if (importErr instanceof ArchiveBusyError) { res.setHeader('Retry-After', '5'); res.status(429).json({ error: importErr.message }); return; }
        if (importErr instanceof BankError) { bankError(res, importErr); return; }
        res.status(400).json({ error: importErr instanceof Error ? importErr.message : 'Invalid .legion file' });
      }
    });
  });
  router.get('/api/bank/:id/export-legion', handle((req, res) => {
    const id = param(req, 'id');
    const { accountId } = accountOf(req);
    const data = bank.editorData(id, accountId);
    const files = bank.files(id, accountId);
    const zip = new AdmZip();
    zip.addFile('editorData.json', Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
    for (const file of files) {
      zip.addFile(`${file.folder}/${file.name}`, file.data);
    }
    const safeName = (data.matchData.matchName || 'question-set').replace(/[^a-zA-Z0-9._-]+/g, '_') || 'question-set';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.legion"`);
    res.send(zip.toBuffer());
  }));
  router.get('/api/bank/:id', handle((req, res) => res.json(bank.snapshot(param(req, 'id'), accountOf(req).accountId))));
  router.patch('/api/bank/:id', handle((req, res) => res.json(bank.rename(param(req, 'id'), accountOf(req).accountId, req.body?.name))));
  router.delete('/api/bank/:id', handle((req, res) => { bank.remove(param(req, 'id'), accountOf(req).accountId); res.sendStatus(204); }));
  router.get('/api/bank/:id/export', handle((req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="question-set.json"');
    res.json(bank.editorData(param(req, 'id'), accountOf(req).accountId));
  }));
  router.post('/api/bank/:id/members', handle((req, res) => {
    if (bank.access(param(req, 'id'), accountOf(req).accountId) !== 'owner') throw new BankError(403, 'Only the owner can share this set');
    const username = string(req.body?.username);
    const account = deps.accounts.byUsername(username);
    if (!account) throw new BankError(404, 'No account with that username');
    bank.share(param(req, 'id'), accountOf(req).accountId, account.id, account.username, req.body?.access);
    res.json(bank.snapshot(param(req, 'id'), accountOf(req).accountId));
  }));
  router.get('/api/bank/:id/sharing', handle((req, res) => {
    const id = param(req, 'id');
    const accountId = accountOf(req).accountId;
    const item = bank.item(id, accountId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ ownerName: deps.accounts.get(item.ownerId)?.username ?? '', link: bank.link(id, accountId) });
  }));
  router.get('/api/bank/:id/sharing/accounts', rateLimit({
    windowMs: 60000, limit: 60, keyGenerator: req => accountOf(req).accountId,
    message: { error: 'Too many account searches' },
  }), handle((req, res) => {
    const accountId = accountOf(req).accountId;
    if (bank.access(param(req, 'id'), accountId) !== 'owner') throw new BankError(403, 'Only the owner can search accounts');
    const query = typeof req.query['q'] === 'string' ? req.query['q'].trim() : '';
    const ownerName = deps.accounts.get(accountId)?.username;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(/^[A-Za-z0-9_.-]{3,32}$/.test(query)
      ? deps.accounts.searchUsernames(query, 9).filter(username => username !== ownerName).slice(0, 8)
      : []);
  }));
  router.put('/api/bank/:id/sharing/link', handle((req, res) => {
    const id = param(req, 'id');
    const accountId = accountOf(req).accountId;
    bank.setLink(id, accountId, req.body?.mode, req.body?.access);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(bank.link(id, accountId));
  }));
  router.post('/api/bank/:id/sharing/open', rateLimit({
    windowMs: 60000, limit: 30, keyGenerator: req => accountOf(req).accountId,
    message: { error: 'Too many link attempts' },
  }), handle((req, res) => {
    bank.openLink(param(req, 'id'), accountOf(req).accountId, req.body?.token);
    res.sendStatus(204);
  }));
  router.post('/api/bank/:id/questions', handle((req, res) => {
    const addedId = bank.addQuestion(param(req, 'id'), accountOf(req).accountId, string(req.body?.pool), req.body?.fields, req.body?.position);
    res.status(201).json({ addedId });
  }));
  router.delete('/api/bank/:id/questions/:section', handle((req, res) => {
    bank.deleteQuestion(param(req, 'id'), accountOf(req).accountId, param(req, 'section'));
    res.json(bank.snapshot(param(req, 'id'), accountOf(req).accountId));
  }));
  router.put('/api/bank/:id/order', handle((req, res) => {
    bank.reorder(param(req, 'id'), accountOf(req).accountId, string(req.body?.pool), req.body?.ids);
    res.sendStatus(204);
  }));
  router.post('/api/bank/:id/reservations/:section', handle((req, res) => {
    const { accountId, sessionId } = accountOf(req);
    const account = deps.accounts.get(accountId);
    if (!account) throw new BankError(401, 'Sign in again');
    res.json(bank.reserve(param(req, 'id'), accountId, account.username, sessionId, string(req.body?.tabId), param(req, 'section')));
  }));
  router.patch('/api/bank/:id/reservations/:section', handle((req, res) => {
    const { accountId, sessionId } = accountOf(req);
    res.json(bank.renew(param(req, 'id'), accountId, sessionId, string(req.body?.tabId), param(req, 'section'), string(req.body?.token)));
  }));
  router.delete('/api/bank/:id/reservations/:section', handle((req, res) => {
    const { accountId, sessionId } = accountOf(req);
    bank.release(param(req, 'id'), accountId, sessionId, string(req.body?.tabId), param(req, 'section'), string(req.body?.token));
    res.sendStatus(204);
  }));
  router.put('/api/bank/:id/sections/:section', handle((req, res) => {
    const { accountId, sessionId } = accountOf(req);
    if (!Number.isSafeInteger(req.body?.revision) || req.body.revision < 0) throw new BankError(400, 'Invalid revision');
    bank.save(param(req, 'id'), accountId, sessionId, string(req.body?.tabId), param(req, 'section'), string(req.body?.token), req.body.revision, req.body?.fields);
    res.json(bank.snapshot(param(req, 'id'), accountId));
  }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.config.uploadLimitBytes, files: 1, fields: 4, fieldSize: 256, parts: 6 },
  });
  router.post('/api/bank/:id/media', (req, res) => {
    try { bank.access(param(req, 'id'), accountOf(req).accountId, true); }
    catch (error) { bankError(res, error); return; }
    upload.single('file')(req, res, (error: unknown) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'File exceeds upload limit' });
        } else {
          res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid upload' });
        }
        return;
      }
      try {
        if (!req.file) throw new BankError(400, 'Choose a file');
        const { accountId, sessionId } = accountOf(req);
        const name = bank.upload(param(req, 'id'), accountId, sessionId, string(req.body?.tabId), string(req.body?.sectionId), string(req.body?.token), string(req.body?.kind), req.file.mimetype, req.file.buffer);
        res.status(201).json({ name });
      } catch (error) { bankError(res, error); }
    });
  });
  router.get('/api/bank/:id/media/:kind/:name', handle((req, res) => {
    const media = bank.media(param(req, 'id'), accountOf(req).accountId, param(req, 'kind'), param(req, 'name'));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'attachment');
    res.type(media.mime);
    if (media.content.kind === 'buffer') { res.send(media.content.bytes); return; }
    res.sendFile(media.content.path, { cacheControl: false, lastModified: false }, error => {
      if (!error) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = 'status' in error ? error.status : undefined;
      res.sendStatus(status === 404 || status === 416 ? status : 500);
    });
  }));
  return router;
}
