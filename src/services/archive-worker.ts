import AdmZip from 'adm-zip';
import { isMainThread, parentPort, workerData } from 'worker_threads';
import { inflateRawSync } from 'zlib';
import { ROUND_KINDS } from '../contracts/game';
import { validateMediaFile } from './media-validation';

const EDITOR_DATA_ENTRY = 'editorData.json';
const MEDIA_FOLDERS = [...ROUND_KINDS, 'misc'] as const;
export type ArchiveMediaFolder = (typeof MEDIA_FOLDERS)[number];

export const MAX_ARCHIVE_ENTRIES = 1000;
export const MAX_EDITOR_DATA_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_ARCHIVE_ENTRY_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB

export interface ParsedArchive {
  editorData: unknown;
  files: { folder: ArchiveMediaFolder; name: string; data: Uint8Array }[];
  totalMediaBytes: number;
}

export type ArchiveErrorCode = 'QUOTA' | 'LIMIT' | 'MEDIA' | 'INVALID';

export class ArchiveParseError extends Error {
  constructor(
    readonly code: ArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveParseError';
  }
}

function decompressEntryBounded(
  entry: AdmZip.IZipEntry,
  maxBytes: number,
  overflowCode: ArchiveErrorCode,
  overflowMessage: string,
): Buffer {
  if (maxBytes < 0 || entry.header.size > maxBytes) {
    throw new ArchiveParseError(overflowCode, overflowMessage);
  }
  const method = entry.header.method;
  const compressed = entry.getCompressedData();
  if (method === 0) {
    if (compressed.length > maxBytes) {
      throw new ArchiveParseError(overflowCode, overflowMessage);
    }
    return Buffer.from(compressed);
  }
  if (method === 8) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: maxBytes });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw new ArchiveParseError(overflowCode, overflowMessage);
      }
      throw new ArchiveParseError('INVALID', 'Invalid .legion file: corrupt compressed entry');
    }
  }
  throw new ArchiveParseError('INVALID', `Unsupported ZIP compression method: ${method}`);
}

export function parseArchiveBuffer(
  rawBuffer: Uint8Array,
  options: { maxMediaBytes?: number } = {},
): ParsedArchive {
  const buffer = Buffer.isBuffer(rawBuffer)
    ? rawBuffer
    : Buffer.from(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ArchiveParseError('INVALID', 'Invalid .legion file: unreadable ZIP archive');
  }

  const editorEntry = zip.getEntry(EDITOR_DATA_ENTRY);
  if (!editorEntry || editorEntry.isDirectory) {
    throw new ArchiveParseError('INVALID', `Invalid .legion file: missing ${EDITOR_DATA_ENTRY}`);
  }

  const editorBytes = decompressEntryBounded(
    editorEntry,
    MAX_EDITOR_DATA_BYTES,
    'LIMIT',
    'Archive editorData.json exceeds maximum allowed size',
  );

  let parsedEditor: unknown;
  try {
    parsedEditor = JSON.parse(editorBytes.toString('utf8'));
  } catch {
    throw new ArchiveParseError('INVALID', `Invalid .legion file: ${EDITOR_DATA_ENTRY} is not valid JSON`);
  }
  if (
    !parsedEditor ||
    typeof parsedEditor !== 'object' ||
    !('matchData' in parsedEditor) ||
    !('questionBank' in parsedEditor)
  ) {
    throw new ArchiveParseError(
      'INVALID',
      `Invalid .legion file: ${EDITOR_DATA_ENTRY} must contain matchData and questionBank`,
    );
  }

  const mediaBudget =
    options.maxMediaBytes !== undefined && Number.isFinite(options.maxMediaBytes)
      ? Math.min(options.maxMediaBytes, MAX_ARCHIVE_TOTAL_BYTES)
      : MAX_ARCHIVE_TOTAL_BYTES;
  const budgetOverflowCode: ArchiveErrorCode =
    options.maxMediaBytes !== undefined && options.maxMediaBytes <= MAX_ARCHIVE_TOTAL_BYTES
      ? 'QUOTA'
      : 'LIMIT';

  const files: { folder: ArchiveMediaFolder; name: string; data: Uint8Array }[] = [];
  let totalMedia = 0;
  let totalArchive = editorBytes.length;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.entryName === EDITOR_DATA_ENTRY) continue;
    const segments = entry.entryName.replace(/\\/g, '/').split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const folder = segments[0] as ArchiveMediaFolder;
    if (!MEDIA_FOLDERS.includes(folder)) continue;
    if (files.length + 1 > MAX_ARCHIVE_ENTRIES) {
      throw new ArchiveParseError('LIMIT', 'Archive has too many media entries');
    }

    const remainingMedia = mediaBudget - totalMedia;
    const remainingTotal = MAX_ARCHIVE_TOTAL_BYTES - totalArchive;
    const entryCap = Math.min(MAX_ARCHIVE_ENTRY_BYTES, remainingMedia, remainingTotal);
    const overflowCode: ArchiveErrorCode =
      remainingMedia <= remainingTotal && remainingMedia <= MAX_ARCHIVE_ENTRY_BYTES
        ? budgetOverflowCode
        : 'LIMIT';
    const overflowMessage =
      overflowCode === 'QUOTA'
        ? 'Room storage is full'
        : 'Archive decompresses past the allowed size limit';

    const data = decompressEntryBounded(entry, entryCap, overflowCode, overflowMessage);
    totalMedia += data.length;
    totalArchive += data.length;

    const name = segments[segments.length - 1];
    if (!validateMediaFile(name, data)) {
      throw new ArchiveParseError('MEDIA', `Unsupported or invalid media file in archive: ${name}`);
    }
    files.push({ folder, name, data });
  }

  return { editorData: parsedEditor, files, totalMediaBytes: totalMedia };
}

if (!isMainThread && parentPort) {
  try {
    const { buffer, maxMediaBytes } = workerData as {
      buffer: Uint8Array;
      maxMediaBytes?: number;
    };
    const result = parseArchiveBuffer(buffer, { maxMediaBytes });
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    if (err instanceof ArchiveParseError) {
      parentPort.postMessage({ ok: false, code: err.code, message: err.message });
    } else {
      parentPort.postMessage({
        ok: false,
        code: 'INVALID',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
