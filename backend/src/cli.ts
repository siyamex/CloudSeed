import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkPassphrase, createBackup, restoreBackup, verifyBackup } from './backup/backup.js';
import { restoreDrill } from './backup/drill.js';
import { randomBytes } from 'node:crypto';
import { checkPasswordPolicy, setPassword } from './auth/local.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { reconcile } from './maintenance/reconcile.js';
import { migrateStorage } from './storage/migrate.js';
import { createStorages } from './storage/index.js';

const USAGE = `CloudSeed command line tools

  cli backup --out <file> [--no-objects] [--strict]   Encrypted backup of the database and (by default) all stored files
  cli verify <file>                                     Check a backup's integrity without touching anything
  cli restore <file> --yes                              Restore into an EMPTY database (runs migrations first)
  cli restore-test <file>                               Prove a backup restores: loads it into a throwaway database and directory, checks it, deletes both
  cli reconcile [--delete-orphans] [--fix-quotas] [--grace-hours 24] [--json]
                                                        Compare the database with storage; exits 1 if anything is off
  cli migrate-storage --from local --to s3 [--dry-run] [--delete-originals]
  cli create-admin <email>                              Create an administrator (or give an existing user a password and admin rights)
  cli reset-password <email>                            Set a new password for a locked-out account (prints a random one unless NEW_PASSWORD is set)
  cli migrate                                           Apply database migrations

The backup passphrase is read from BACKUP_PASSPHRASE or from the file named by BACKUP_PASSPHRASE_FILE (never from arguments).
Everything else (database, storage) comes from the same environment variables as the server.`;

async function passphrase(): Promise<string> {
  const file = process.env.BACKUP_PASSPHRASE_FILE;
  const p = file ? (await readFile(file, 'utf8')).replace(/\r?\n$/, '') : process.env.BACKUP_PASSPHRASE;
  return checkPassphrase(p);
}
const say = (m: string) => console.log(m);
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { say(USAGE); return cmd ? 0 : 1; }
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      out: { type: 'string' }, 'no-objects': { type: 'boolean' }, strict: { type: 'boolean' }, yes: { type: 'boolean' },
      'delete-orphans': { type: 'boolean' }, 'fix-quotas': { type: 'boolean' }, 'grace-hours': { type: 'string' }, json: { type: 'boolean' },
      from: { type: 'string' }, to: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'delete-originals': { type: 'boolean' },
    },
  });

  if (cmd === 'verify') {
    const file = positionals[0];
    if (!file) throw new Error('usage: cli verify <file>');
    const v = await verifyBackup(file, await passphrase());
    say(`OK  made ${v.createdAt}; ${v.totalRows} rows in ${Object.keys(v.rows).length} tables; ${v.objects.count} objects (${mb(v.objects.bytes)})${v.includeObjects ? '' : ' [database only]'}`);
    for (const m of v.missing) say(`NOTE  object was already missing when the backup was made: ${m.kind}:${m.key}`);
    for (const c of v.corrupt) say(`NOTE  object was already damaged when the backup was made: ${c.kind}:${c.key} (${c.reason})`);
    return 0;
  }

  const config = loadConfig();
  const db = createPgDb(config.DATABASE_URL, config.DB_POOL_MAX);
  const { storage, storages, adapterFor } = createStorages(config);
  try {
    switch (cmd) {
      case 'migrate': {
        const ran = await migrate(db, config.MIGRATIONS_DIR, say);
        say(ran.length ? `${ran.length} migration(s) applied` : 'database is up to date');
        return 0;
      }
      case 'create-admin':
      case 'reset-password': {
        const email = positionals[0]?.trim().toLowerCase();
        if (!email) throw new Error(`usage: cli ${cmd} <email>`);
        const given = process.env.NEW_PASSWORD;
        const password = given ?? randomBytes(15).toString('base64url');
        const bad = checkPasswordPolicy(password, email);
        if (bad) throw new Error(`NEW_PASSWORD is not acceptable: ${bad}`);
        let user = (await db.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1 AND status <> 'deleted'`, [email])).rows[0];
        if (!user) {
          if (cmd === 'reset-password') throw new Error(`There is no account for ${email}.`);
          user = await db.tx(async (t) => {
            const id = (await t.query<{ id: string }>(`INSERT INTO users (email, email_verified) VALUES ($1, TRUE) RETURNING id`, [email])).rows[0]!.id;
            await t.query(`INSERT INTO user_profiles (user_id) VALUES ($1)`, [id]);
            await t.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 1)`, [id]);
            await t.query(`INSERT INTO storage_quotas (user_id, quota_bytes) VALUES ($1, $2)`, [id, config.DEFAULT_USER_QUOTA_BYTES]);
            return { id };
          });
        }
        if (cmd === 'create-admin') await db.query(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2) ON CONFLICT DO NOTHING`, [user.id]);
        await setPassword(db, user.id, password);
        await db.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]); // everyone signed in as this account is signed out
        await db.query(`INSERT INTO audit_logs (user_id, action) VALUES ($1, $2)`, [user.id, cmd === 'create-admin' ? 'admin.cli_create_admin' : 'admin.cli_reset_password']);
        say(`${cmd === 'create-admin' ? 'Administrator ready' : 'Password reset'} for ${email}.`);
        if (!given) say(`New password (shown once, change it after signing in): ${password}`);
        return 0;
      }
      case 'backup': {
        if (!values.out) throw new Error('usage: cli backup --out <file>');
        const out = path.resolve(values.out);
        const s = await createBackup({ db, out, passphrase: await passphrase(), includeObjects: !values['no-objects'], adapterFor, log: say });
        say(`Backup written: ${out} (${mb(s.bytes)}), ${Object.values(s.rows).reduce((a, b) => a + b, 0)} rows, ${s.objects.included} objects (${mb(s.objects.bytes)})`);
        for (const m of s.missing) say(`WARNING  object missing from storage, not in the backup: ${m.kind}:${m.key}`);
        for (const c of s.corrupt) say(`WARNING  object inconsistent: ${c.kind}:${c.key} (${c.reason})`);
        if (values['no-objects']) say('NOTE  stored files are NOT included (--no-objects). Back them up separately.');
        say('Remember: the backup does not contain ENCRYPTION_KEY or SESSION_SECRET. Store them safely, separately. Without ENCRYPTION_KEY, saved Telegram bot tokens cannot be decrypted after a restore.');
        return values.strict && (s.missing.length || s.corrupt.length) ? 2 : 0;
      }
      case 'restore': {
        const file = positionals[0];
        if (!file) throw new Error('usage: cli restore <file> --yes');
        if (!values.yes) throw new Error('restore writes to the database in DATABASE_URL and to storage. Re-run with --yes once you have checked that this is the right, empty target.');
        await migrate(db, config.MIGRATIONS_DIR, say);
        const r = await restoreBackup({ db, file, passphrase: await passphrase(), adapterFor, log: say });
        say(`Restored ${r.totalRows} rows and ${r.objects.count} objects (${mb(r.objects.bytes)}) from the backup made ${r.createdAt}.`);
        say('Next: start the app with the SAME ENCRYPTION_KEY as before, then run "cli reconcile".');
        return 0;
      }
      case 'restore-test': {
        const file = positionals[0];
        if (!file) throw new Error('usage: cli restore-test <file>');
        const r = await restoreDrill({ databaseUrl: config.DATABASE_URL, migrationsDir: config.MIGRATIONS_DIR, file, passphrase: await passphrase(), log: say });
        say(`Restored ${r.restored.totalRows} rows and ${r.restored.objects.count} objects into a temporary database; it has been deleted again.`);
        for (const m of r.rowMismatches) say(`MISMATCH  ${m.table}: archive has ${m.expected} rows, restored database has ${m.actual}`);
        for (const m of r.reconcile.missing) say(`MISSING   ${m.table} ${m.id}`);
        for (const m of r.reconcile.sizeMismatch) say(`SIZE      ${m.id}: recorded ${m.recorded}, restored ${m.stored}`);
        say(r.ok ? 'RESTORE TEST PASSED: this backup can be restored.' : 'RESTORE TEST FAILED: do not rely on this backup.');
        return r.ok ? 0 : 1;
      }
      case 'reconcile': {
        const r = await reconcile({
          db, adapterFor, deleteOrphans: values['delete-orphans'], fixQuotas: values['fix-quotas'],
          orphanGraceHours: values['grace-hours'] ? Number(values['grace-hours']) : undefined, log: values.json ? undefined : say,
        });
        if (values.json) say(JSON.stringify(r, null, 2));
        else {
          say(`Checked ${r.checked.rows} records and ${r.checked.objects} stored objects.`);
          for (const m of r.missing) say(`MISSING   ${m.table} ${m.id}: ${m.kind}:${m.key} (restore it from a backup)`);
          for (const m of r.sizeMismatch) say(`SIZE      ${m.id}: recorded ${m.recorded} bytes, stored ${m.stored} bytes (${m.kind}:${m.key})`);
          for (const m of r.orphans) say(`ORPHAN    ${m.kind}:${m.key} (${mb(m.size)}, ${m.ageHours} h old)${m.deleted ? ' - deleted' : ''}`);
          for (const m of r.quotaDrift) say(`QUOTA     user ${m.userId}: recorded ${m.recorded}, actual ${m.actual}${m.fixed ? ' - corrected' : ''}`);
          if (!r.missing.length && !r.sizeMismatch.length && !r.orphans.length && !r.quotaDrift.length) say('Everything is consistent.');
        }
        const unresolved = r.missing.length + r.sizeMismatch.length + r.orphans.filter((x) => !x.deleted).length + r.quotaDrift.filter((x) => !x.fixed).length;
        return unresolved ? 1 : 0;
      }
      case 'migrate-storage': {
        if (!values.from || !values.to) throw new Error('usage: cli migrate-storage --from local --to s3');
        const from = storages[values.from as 'local' | 's3'], to = storages[values.to as 'local' | 's3'];
        if (!from || !to) throw new Error(`Both backends must be configured. For s3 set STORAGE_BACKEND=s3 and the S3_* variables in this command's environment (new uploads use: ${storage.kind}).`);
        const r = await migrateStorage({ db, from, to, dryRun: values['dry-run'], deleteOriginals: values['delete-originals'], log: say });
        say(`${r.dryRun ? 'Would move' : 'Moved'} ${r.moved} objects (${mb(r.bytes)}); ${r.alreadyThere} were already at the destination; ${r.skippedGone} files vanished meanwhile; ${r.failed.length} failed; ${r.originalsDeleted} originals deleted.`);
        for (const f of r.failed) say(`FAILED  ${f.table} ${f.id} ${f.key}: ${f.reason}`);
        if (!r.dryRun && !values['delete-originals']) say('The originals were kept. After checking, remove them with: cli migrate-storage ... --delete-originals (it skips what is already moved), or delete the old data directory.');
        return r.failed.length ? 1 : 0;
      }
      default:
        say(USAGE);
        return 1;
    }
  } finally {
    await db.close();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
