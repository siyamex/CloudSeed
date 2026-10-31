export interface ArchiveEntry {
  /** Forward-slash path inside the archive, no leading slash. */
  path: string;
  size: number;
  isDir: boolean;
  encrypted: boolean;
  isLink: boolean;
  modifiedAt: string | null;
}

export class ArchiveError extends Error {
  constructor(public readonly code: 'not_an_archive' | 'too_many_entries' | 'encrypted' | 'unsupported' | 'too_large' | 'no_tool' | 'not_found' | 'tool_failed', message: string) {
    super(message);
  }
}

/** Paths from archives are untrusted: this returns a clean relative path or null when it should never be used. */
export function safeEntryPath(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  const p = raw.replace(/\\/g, '/').normalize('NFC');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.some((s) => s === '..' || Buffer.byteLength(s) > 255)) return null;
  return parts.join('/');
}
