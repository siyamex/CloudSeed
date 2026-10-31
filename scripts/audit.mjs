/**
 * `npm audit` for the production dependencies, failing on high/critical findings EXCEPT the ones listed below on purpose.
 * Each exception says why it does not apply here and has a review date: after that date the build fails again until someone
 * looks at it. Anything not listed fails the build, exactly like `npm audit --audit-level=high`.
 */
import { spawnSync } from 'node:child_process';

const ACCEPTED = {
  'GHSA-2p57-rm9w-gvfp': {
    package: 'ip',
    reason: 'The advisory is about ip.isPublic(). The package arrives through webtorrent > torrent-discovery > bittorrent-tracker, where it is used only by '
      + 'the tracker SERVER code (lib/server/parse-udp.js). CloudSeed never runs a tracker server, and never calls isPublic(); peer and tracker address '
      + 'checks use Node\'s net.BlockList (see backend/src/downloads/ssrf.ts).',
    review: '2027-04-30',
  },
};

const r = spawnSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
let report;
try { report = JSON.parse(r.stdout); } catch { console.error('Could not read the output of npm audit:\n', r.stdout || r.stderr); process.exit(2); }

const found = new Map();
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== 'object' || !via.url) continue;
    if (['high', 'critical'].includes(via.severity)) found.set(via.url.split('/').pop(), { id: via.url.split('/').pop(), pkg: via.name, title: via.title, severity: via.severity });
  }
}

let failed = false;
const today = new Date().toISOString().slice(0, 10);
for (const a of found.values()) {
  const ok = ACCEPTED[a.id];
  if (!ok) { failed = true; console.error(`FAIL  ${a.severity.toUpperCase()}  ${a.pkg}: ${a.title}  (${a.id})`); continue; }
  if (today > ok.review) { failed = true; console.error(`FAIL  accepted exception ${a.id} (${a.pkg}) passed its review date ${ok.review}. Re-check it: ${ok.reason}`); continue; }
  console.log(`ACCEPTED  ${a.id} (${a.pkg}) until ${ok.review}: ${ok.reason}`);
}
if (!failed) console.log(found.size ? 'No unaccepted high or critical vulnerabilities.' : 'No high or critical vulnerabilities.');
process.exit(failed ? 1 : 0);
