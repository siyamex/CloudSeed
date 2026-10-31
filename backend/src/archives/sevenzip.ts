import { spawn } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import type { ArchiveEntry } from './types.js';
import { ArchiveError } from './types.js';

/**
 * 7Z and RAR (and ZIP too) through the system 7-Zip (`7zz`; the Docker image installs it). The archive has to be a local
 * file for random access, so object-store files are copied to a temporary file first (the caller does that).
 * Entry names are passed after `--` and with `-spd` so a name starting with "-" or containing "*" is never a switch or wildcard.
 */

let available: Promise<boolean> | undefined;
export function sevenZipAvailable(bin: string): Promise<boolean> {
  available ??= new Promise((resolve) => {
    const c = spawn(bin, ['i'], { stdio: 'ignore' });
    c.once('error', () => resolve(false));
    c.once('exit', (code) => resolve(code === 0));
  });
  return available;
}
/** For tests that switch the binary. */
export function resetSevenZipProbe(): void { available = undefined; }

function run(bin: string, args: string[], timeoutMs: number, maxOut = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let n = 0; let err = '';
    const timer = setTimeout(() => { c.kill('SIGKILL'); reject(new ArchiveError('tool_failed', 'Reading the archive took too long')); }, timeoutMs);
    c.stdout.on('data', (d: Buffer) => { n += d.length; if (n > maxOut) { c.kill('SIGKILL'); reject(new ArchiveError('too_many_entries', 'The archive listing is too large')); } else out.push(d); });
    c.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
    c.once('error', (e) => { clearTimeout(timer); reject(new ArchiveError('no_tool', `Cannot run ${bin}: ${(e as Error).message}`)); });
    c.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) resolve(Buffer.concat(out).toString('utf8')); // 1 = warnings only
      else reject(new ArchiveError(/password|encrypted|wrong/i.test(err) ? 'encrypted' : /not archive|Can(?:not| not) open|Unsupported|Is not archive/i.test(err) ? 'not_an_archive' : 'tool_failed', `Could not read the archive (7-Zip code ${code})`));
    });
  });
}

export async function list7z(bin: string, file: string, maxEntries: number): Promise<ArchiveEntry[]> {
  const text = await run(bin, ['l', '-slt', '-ba', '-sccUTF-8', '-spd', '--', file], 120_000);
  const entries: ArchiveEntry[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const kv = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) { const i = line.indexOf(' = '); if (i > 0) kv.set(line.slice(0, i), line.slice(i + 3)); }
    const p = kv.get('Path');
    if (p === undefined) continue;
    if (entries.length >= maxEntries) throw new ArchiveError('too_many_entries', `This archive has more than ${maxEntries} entries`);
    const attr = kv.get('Attributes') ?? '';
    const mod = kv.get('Modified');
    entries.push({
      path: p.replace(/\\/g, '/'), size: Number(kv.get('Size') ?? 0) || 0,
      isDir: kv.get('Folder') === '+' || /^D/.test(attr), encrypted: kv.get('Encrypted') === '+',
      isLink: kv.has('Symbolic Link') || /(^|\s)l[rwxsStT-]{9}/.test(attr),
      modifiedAt: mod && /^\d{4}-\d\d-\d\d/.test(mod) ? new Date(mod.replace(' ', 'T') + 'Z').toISOString() : null,
    });
  }
  return entries;
}

/** Streams one entry (decompressed) from 7-Zip's stdout, ending with an error when it passes `maxBytes`. */
export function open7zEntry(bin: string, file: string, entryPath: string, maxBytes: number, timeoutMs = 600_000): Readable {
  const out = new PassThrough();
  const c = spawn(bin, ['e', '-so', '-spd', '-sccUTF-8', '--', file, entryPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let n = 0; let err = ''; let failed = false;
  const fail = (e: ArchiveError) => { if (failed) return; failed = true; c.kill('SIGKILL'); out.destroy(e); };
  const timer = setTimeout(() => fail(new ArchiveError('tool_failed', 'Unpacking took too long')), timeoutMs);
  c.stdout.on('data', (d: Buffer) => {
    n += d.length;
    if (n > maxBytes) return fail(new ArchiveError('too_large', 'The entry is larger than allowed'));
    if (!out.write(d)) { c.stdout.pause(); out.once('drain', () => c.stdout.resume()); }
  });
  c.stderr.on('data', (d: Buffer) => { if (err.length < 2000) err += d.toString(); });
  c.once('error', (e) => fail(new ArchiveError('no_tool', `Cannot run ${bin}: ${(e as Error).message}`)));
  c.once('exit', (code) => {
    clearTimeout(timer);
    if (failed) return;
    if (code === 0 || code === 1) out.end();
    else fail(new ArchiveError(/password|encrypted|wrong/i.test(err) ? 'encrypted' : /No files to process|not found/i.test(err) ? 'not_found' : 'tool_failed', 'Could not unpack the entry'));
  });
  out.once('close', () => { clearTimeout(timer); if (c.exitCode === null) c.kill('SIGKILL'); });
  return out;
}
