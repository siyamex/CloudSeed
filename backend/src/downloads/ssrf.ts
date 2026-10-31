import dns from 'node:dns';
import { BlockList, isIP } from 'node:net';

export class BlockedDestinationError extends Error {
  readonly code = 'blocked_destination';
  constructor(msg = 'Destination is not allowed') { super(msg); }
}

const V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6: [string, number][] = [
  ['::', 128], ['::1', 128],
  // IPv4-mapped (::ffff:a.b.c.d) is NOT listed: Node's BlockList treats it as equivalent to the IPv4 address,
  // so the IPv4 rules above already cover it (adding ::ffff:0:0/96 would block every IPv4 address).
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], // discard, Teredo, documentation, 6to4
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], // unique-local, link-local, multicast
];

const blocked = new BlockList();
for (const [a, p] of V4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6) blocked.addSubnet(a, p, 'ipv6');

export function parseCidrs(list: string): BlockList {
  const allow = new BlockList();
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = raw.split('/');
    const fam = isIP(addr ?? '');
    if (!addr || !fam) throw new Error(`Invalid DOWNLOAD_ALLOWED_CIDRS entry: ${raw}`);
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) allow.addAddress(addr, type);
    else allow.addSubnet(addr, Number(bits), type);
  }
  return allow;
}

export interface Guard {
  /** Syntactic + literal-IP validation. Throws BlockedDestinationError / TypeError. */
  assertUrl(raw: string | URL): URL;
  /** Resolves the hostname and checks every address (fast feedback before queueing). */
  assertResolvable(url: URL): Promise<void>;
  /** DNS lookup for http(s).request: validates the answer that the socket will actually connect to. */
  lookup: typeof dns.lookup;
}

export function createGuard(opts: { allowedCidrs?: string; allowedPorts?: string } = {}): Guard {
  const allow = parseCidrs(opts.allowedCidrs ?? '');
  const ports = new Set((opts.allowedPorts ?? '80,443').split(',').map((s) => Number(s.trim())).filter(Boolean));

  const isBlockedIp = (ip: string): boolean => {
    const fam = isIP(ip);
    if (!fam) return true; // unparseable -> refuse
    const type = fam === 4 ? 'ipv4' : 'ipv6';
    if (allow.check(ip, type)) return false;
    return blocked.check(ip, type);
  };

  const assertUrl = (raw: string | URL): URL => {
    const u = typeof raw === 'string' ? new URL(raw) : raw;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedDestinationError('Only http and https URLs are supported');
    if (u.username || u.password) throw new BlockedDestinationError('URLs with embedded credentials are not supported');
    if (!u.hostname) throw new BlockedDestinationError('URL has no host');
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (!ports.has(port)) throw new BlockedDestinationError(`Port ${port} is not allowed`);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && isBlockedIp(host)) throw new BlockedDestinationError();
    return u;
  };

  // The address validated here is the one handed to the socket, so DNS rebinding cannot swap it afterwards.
  const lookup = ((hostname: string, options: dns.LookupOptions | number | undefined, cb: (...a: unknown[]) => void) => {
    const o = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { ...o, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = addrs as dns.LookupAddress[];
      if (list.length === 0 || list.some((a) => isBlockedIp(a.address))) return cb(new BlockedDestinationError());
      if (o.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    });
  }) as unknown as typeof dns.lookup;

  const assertResolvable = async (u: URL) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return; // already checked by assertUrl
    const addrs = await dns.promises.lookup(host, { all: true });
    if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) throw new BlockedDestinationError();
  };

  return { assertUrl, assertResolvable, lookup };
}
