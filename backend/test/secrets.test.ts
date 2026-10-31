import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ensureSecret, resolveSecrets } from '../src/secrets.js';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'cs-secrets-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const fresh = async () => mkdtemp(path.join(dir, 'd-'));

describe('generated secrets', () => {
  it('are created once and then read back unchanged', async () => {
    const d = await fresh();
    const a = ensureSecret(d, 'session_secret'), b = ensureSecret(d, 'session_secret');
    expect(a.created).toBe(true);
    expect(b).toEqual({ value: a.value, created: false });
    expect(a.value.length).toBeGreaterThanOrEqual(48);
    expect(Buffer.from(ensureSecret(d, 'encryption_key').value, 'base64')).toHaveLength(32);
    expect(await readdir(d)).toEqual(['db_password'].filter(() => false).concat(['encryption_key', 'session_secret'])); // no temporary files left behind
  });

  it.skipIf(process.platform === 'win32')('are private to the app, except the database password which the database container must read', async () => {
    const d = await fresh();
    for (const n of ['session_secret', 'encryption_key', 'db_password'] as const) ensureSecret(d, n);
    expect(((await stat(path.join(d, 'session_secret'))).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(path.join(d, 'encryption_key'))).mode & 0o777).toString(8)).toBe('600');
    expect(((await stat(path.join(d, 'db_password'))).mode & 0o777).toString(8)).toBe('644');
  });

  it('are the same for every container that starts at the same moment', async () => {
    const d = await fresh();
    const mod = pathToFileURL(path.resolve('src/secrets.ts')).href;
    const script = ['import { ensureSecret } from ' + JSON.stringify(mod) + ';', 'const r = ensureSecret(' + JSON.stringify(d) + ", 'encryption_key');", 'console.log(JSON.stringify(r));'].join(' ');
    const run = () => new Promise<{ value: string; created: boolean }>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: path.resolve('.') });
      let out = '', err = '';
      p.stdout.on('data', (c) => (out += c)); p.stderr.on('data', (c) => (err += c));
      p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop()!)) : reject(new Error(err || `exit ${code}`))));
    });
    const results = await Promise.all(Array.from({ length: 8 }, run));
    expect(new Set(results.map((r) => r.value)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    expect((await readFile(path.join(d, 'encryption_key'), 'utf8')).trim()).toBe(results[0]!.value);
  }, 60_000);
});

describe('which value wins', () => {
  it('an explicit value beats a file, which beats a generated one; the real environment is never touched', async () => {
    const d = await fresh();
    await writeFile(path.join(d, 'f'), '  from-a-secret-file  \n');
    const env = { SECRETS_DIR: d, SESSION_SECRET: 'explicit', ENCRYPTION_KEY_FILE: path.join(d, 'f') } as NodeJS.ProcessEnv;
    const out = resolveSecrets(env);
    expect(out.SESSION_SECRET).toBe('explicit');
    expect(out.ENCRYPTION_KEY).toBe('from-a-secret-file');
    expect(env.ENCRYPTION_KEY).toBeUndefined();
    expect((await readdir(d)).sort()).toEqual(['f']); // nothing was generated for values that were given
    expect(resolveSecrets({}).SESSION_SECRET).toBeUndefined(); // without SECRETS_DIR nothing is invented
  });

  it('refuses an empty secret file instead of silently running without a secret', async () => {
    const d = await fresh();
    await writeFile(path.join(d, 'empty'), '\n');
    expect(() => resolveSecrets({ SESSION_SECRET_FILE: path.join(d, 'empty') } as NodeJS.ProcessEnv)).toThrow(/empty/);
  });

  it('builds the database address from its parts, with the password safely encoded', async () => {
    const d = await fresh();
    await writeFile(path.join(d, 'pw'), 'p@ss/w:rd#?&%\n');
    const env = resolveSecrets({ DB_HOST: 'postgres', DB_USER: 'cs', DB_NAME: 'data', DB_PASSWORD_FILE: path.join(d, 'pw') } as NodeJS.ProcessEnv);
    const u = new URL(env.DATABASE_URL!);
    expect([u.hostname, u.port, u.username, u.pathname, decodeURIComponent(u.password)]).toEqual(['postgres', '5432', 'cs', '/data', 'p@ss/w:rd#?&%']);
    expect(resolveSecrets({ DB_HOST: 'x', DATABASE_URL: 'postgres://given' } as NodeJS.ProcessEnv).DATABASE_URL).toBe('postgres://given');
    expect(resolveSecrets({} as NodeJS.ProcessEnv).DATABASE_URL).toBeUndefined();
  });
});

describe('a production start with nothing configured but the secrets folder', () => {
  it('passes every safety check, and a second container sees the same values', async () => {
    const d = await fresh();
    const env = { NODE_ENV: 'production', SECRETS_DIR: d, DB_HOST: 'postgres', ALLOW_INSECURE_HTTP: 'true' } as NodeJS.ProcessEnv;
    const a = loadConfig(env), b = loadConfig(env);
    expect(a.SESSION_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(a.ENCRYPTION_KEY, 'base64')).toHaveLength(32);
    expect(a.DATABASE_URL).toMatch(/^postgres:\/\/cloudseed:[^@]+@postgres:5432\/cloudseed$/);
    expect(a.DATABASE_URL).not.toContain('cloudseed:cloudseed@');
    expect([b.SESSION_SECRET, b.ENCRYPTION_KEY, b.DATABASE_URL]).toEqual([a.SESSION_SECRET, a.ENCRYPTION_KEY, a.DATABASE_URL]);
    expect(a.cookieSecure).toBe(false); // plain http on a home network: cookies cannot be marked Secure
    expect(a.publicUrlConfigured).toBe(false);
  });

  it('still refuses plain http in production unless that was asked for', async () => {
    const d = await fresh();
    expect(() => loadConfig({ NODE_ENV: 'production', SECRETS_DIR: d, DB_HOST: 'postgres' } as NodeJS.ProcessEnv)).toThrow(/https/);
  });
});
