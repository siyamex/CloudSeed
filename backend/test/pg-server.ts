import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Starts a throwaway REAL PostgreSQL server from the binaries shipped by the `embedded-postgres` dev dependency.
 * It is launched with `pg_ctl` (which drops administrator rights on Windows, where postgres.exe refuses to run
 * elevated). Used by `npm run smoke` and `npm run test:pg`; no Docker or system Postgres required.
 *
 * A crashed test run never gets to stop its server, so every server records its owner process and the next start
 * reaps servers whose owner is gone. Without that, leaked servers pile up, eat the machine's memory and make later
 * runs crash too.
 */
export interface TestPostgres {
  /** Superuser connection string for the `postgres` database. */
  adminUrl: string;
  stop(): void;
}

const PREFIX = 'cloudseed-pg-';

function binDir(): string {
  const plat = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform as string];
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (!plat) throw new Error(`unsupported platform ${process.platform}`);
  // npm hoists the platform package to the workspace root; search upwards from here.
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', '@embedded-postgres', `${plat}-${arch}`, 'native', 'bin');
    if (existsSync(p)) return p;
    if (path.dirname(dir) === dir) throw new Error('embedded-postgres binaries not found; run `npm install`');
  }
}

const exe = (n: string) => path.join(binDir(), process.platform === 'win32' ? `${n}.exe` : n);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

/** Stops and deletes servers left behind by test runs that died. Safe to call concurrently with live runs. */
export function reapStaleServers(): number {
  let reaped = 0;
  for (const name of readdirSync(os.tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    let owner = 0;
    try { owner = Number(readFileSync(path.join(dir, 'owner.pid'), 'utf8')); } catch { /* not written yet, or not ours */ }
    if (owner && alive(owner)) continue; // its run is still going
    if (!owner) { // no owner file: only touch it if it has been idle for a while (it may be mid-creation by a live run)
      try { if (Date.now() - statSync(dir).mtimeMs < 10 * 60_000) continue; } catch { continue; }
    }
    try { execFileSync(exe('pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* not running */ }
    try { rmSync(dir, { recursive: true, force: true }); reaped++; } catch { /* still locked; the next run retries */ }
  }
  return reaped;
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});

export async function startPostgres(): Promise<TestPostgres> {
  try { reapStaleServers(); } catch { /* best effort */ }
  const dir = mkdtempSync(path.join(os.tmpdir(), PREFIX));
  writeFileSync(path.join(dir, 'owner.pid'), String(process.pid));
  const data = path.join(dir, 'data');
  const pwfile = path.join(dir, 'pw');
  writeFileSync(pwfile, 'test');
  execFileSync(exe('initdb'), ['-D', data, '-U', 'test', '--pwfile', pwfile, '-A', 'scram-sha-256', '-E', 'UTF8', '--no-sync'], { stdio: 'ignore' });
  const port = await freePort();
  // stdio must be ignored: the server inherits pipes and would otherwise keep execFileSync waiting forever.
  // A small shared_buffers keeps the footprint low; the data is throwaway, so durability settings are off.
  execFileSync(exe('pg_ctl'), ['-D', data, '-l', path.join(dir, 'pg.log'), '-w', '-t', '60', '-o',
    `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=200 -c shared_buffers=16MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, 'start'],
  { stdio: 'ignore' });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { execFileSync(exe('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* already down */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.once('exit', stop);
  return { adminUrl: `postgres://test:test@127.0.0.1:${port}/postgres`, stop };
}
