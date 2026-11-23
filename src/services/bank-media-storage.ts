import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMediaByMime } from './media-validation';

export type BankMediaMode = 'file' | 'sqlite';
export type StoredMedia = { kind: 'file'; path: string } | { kind: 'buffer'; bytes: Buffer };

export interface BankMediaStorage {
  write(id: string, bytes: Buffer): void;
  open(id: string): StoredMedia;
  remove(id: string): void;
}

export class FileBankMediaStorage implements BankMediaStorage {
  constructor(private readonly root: string) {}

  private path(id: string): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error('Invalid bank media ID');
    }
    return resolve(this.root, id);
  }

  write(id: string, bytes: Buffer): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = this.path(id);
    try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') this.remove(id);
      throw error;
    }
  }

  open(id: string): StoredMedia { return { kind: 'file', path: this.path(id) }; }
  remove(id: string): void { rmSync(this.path(id), { force: true }); }
}

export class SqliteBankMediaStorage implements BankMediaStorage {
  constructor(private readonly db: DatabaseSync) {}

  write(id: string, bytes: Buffer): void {
    this.db.prepare('UPDATE media SET data=? WHERE id=?').run(bytes, id);
  }

  open(id: string): StoredMedia {
    const data = this.db.prepare('SELECT data FROM media WHERE id=?').get(id)?.['data'];
    if (!(data instanceof Uint8Array)) throw new Error('Missing bank media payload');
    return { kind: 'buffer', bytes: Buffer.from(data) };
  }

  // The bytes live in the metadata row and are deleted by the same transaction.
  remove(): void {}
}

export function readStoredMedia(media: StoredMedia): Buffer {
  return media.kind === 'file' ? readFileSync(media.path) : media.bytes;
}

/** Match the claimed type to its container signature and pick a safe filename extension. */
export function bankMediaExtension(mime: string, bytes: Buffer): string | undefined {
  return validateMediaByMime(mime, bytes);
}
