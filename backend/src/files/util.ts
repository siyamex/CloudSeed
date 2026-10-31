import path from 'node:path';
import { badRequest } from '../errors.js';

/** Reduces a user-supplied name to a safe single path segment. */
export function sanitizeName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let n = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\\/g, '/');
  n = path.posix.basename(n).trim();
  if (n === '' || n === '.' || n === '..') throw badRequest('Invalid name', 'invalid_name');
  if (Buffer.byteLength(n) > 255) {
    const ext = path.posix.extname(n).slice(0, 20);
    let base = n.slice(0, n.length - ext.length);
    while (Buffer.byteLength(base + ext) > 255) base = base.slice(0, -1);
    n = base + ext;
  }
  return n;
}

/** Validates a folder/file *name* (no separators allowed, unlike sanitizeName which strips them). */
export function validateName(raw: string): string {
  const n = raw.trim();
  if (n === '' || n === '.' || n === '..' || n.length > 255 || /[/\\\u0000-\u001f\u007f]/.test(n)) {
    throw badRequest('Name must be 1-255 characters and cannot contain slashes or control characters', 'invalid_name');
  }
  return n;
}

/** Inserts " (n)" before the extension: report.pdf -> report (1).pdf */
export function numberedName(name: string, n: number): string {
  const ext = path.posix.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base} (${n})${ext}`;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.srt': 'application/x-subrip', '.vtt': 'text/vtt',
};

/** Type is derived from the extension only; client-declared types are untrusted. */
export function mimeFromName(name: string): string {
  return MIME[path.posix.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Parses a single-range `Range: bytes=...` header. Returns null for absent, 'invalid' when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number, end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

export const TYPE_FILTERS: Record<string, string[]> = {
  image: ['image/%'], video: ['video/%'], audio: ['audio/%'], text: ['text/%'],
  pdf: ['application/pdf'], archive: ['application/zip', 'application/gzip', 'application/x-tar', 'application/x-7z-compressed', 'application/vnd.rar'],
};
