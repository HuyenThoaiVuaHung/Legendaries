const ALLOWED_MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
};

const ALLOWED_MIME_PREFIXES: readonly string[] = ['image/', 'audio/', 'video/'];

function ascii(bytes: Buffer, offset: number, marker: string): boolean {
  if (bytes.length < offset + marker.length) return false;
  return bytes.subarray(offset, offset + marker.length).equals(Buffer.from(marker, 'binary'));
}

function matchesMagicBytes(ext: string, bytes: Buffer): boolean {
  if (bytes.length < 2) return false;
  switch (ext) {
    case 'png':
      return ascii(bytes, 0, '\x89PNG\r\n\x1a\n');
    case 'jpg':
    case 'jpeg':
      return ascii(bytes, 0, '\xff\xd8\xff');
    case 'gif':
      return ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a');
    case 'webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP');
    case 'bmp':
      return ascii(bytes, 0, 'BM');
    case 'avif':
      return (
        ascii(bytes, 4, 'ftyp') &&
        (ascii(bytes, 8, 'avif') || ascii(bytes, 8, 'avis') || ascii(bytes, 8, 'mif1'))
      );
    case 'wav':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE');
    case 'ogg':
      return ascii(bytes, 0, 'OggS');
    case 'flac':
      return ascii(bytes, 0, 'fLaC');
    case 'mp3':
      return (
        ascii(bytes, 0, 'ID3') ||
        (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
    case 'mp4':
    case 'm4a':
    case 'mov':
      return ascii(bytes, 4, 'ftyp');
    case 'webm':
    case 'mkv':
      return ascii(bytes, 0, '\x1a\x45\xdf\xa3');
    default:
      return false;
  }
}

export function extensionOf(fileName: string): string {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function safeMimeForFileName(fileName: string): string | null {
  const ext = extensionOf(fileName);
  return ALLOWED_MIME_BY_EXT[ext] ?? null;
}

const PREFERRED_EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
};

export function validateMediaByMime(mime: string, bytes: Buffer): string | undefined {
  const ext = PREFERRED_EXT_BY_MIME[mime.toLowerCase()];
  if (!ext || !matchesMagicBytes(ext, bytes)) return undefined;
  return ext;
}

export function validateMediaFile(
  fileName: string,
  bytes: Buffer,
  options: { pngOnly?: boolean; claimedMime?: string } = {},
): { ext: string; mime: string } | null {
  const ext = extensionOf(fileName);
  const mime = ALLOWED_MIME_BY_EXT[ext];
  if (!mime) return null;
  if (options.pngOnly && ext !== 'png') return null;
  if (options.claimedMime !== undefined) {
    if (options.pngOnly && options.claimedMime !== 'image/png') return null;
    if (!ALLOWED_MIME_PREFIXES.some((prefix) => options.claimedMime!.startsWith(prefix))) {
      return null;
    }
  }
  if (!matchesMagicBytes(ext, bytes)) return null;
  return { ext, mime };
}
