import dns from 'node:dns';
import { isIP } from 'node:net';
import { createIpPolicy } from '../downloads/ssrf.js';

/**
 * What a torrent is allowed to make this server do.
 *
 * A torrent hands the client a list of trackers, web seeds and peers, all chosen by whoever made it. Left alone, that is a way to make
 * the server connect to addresses inside your network. So: peers on private/loopback/link-local ranges are never contacted, web
 * seeds (plain HTTP servers named in the torrent) are switched off, and every tracker is resolved here first and must be public.
 */

/** The minimal shape of a parsed torrent that this code touches (parse-torrent has no type definitions). */
export interface ParsedTorrent {
  infoHash: string;
  name?: string;
  announce?: string[];
  urlList?: string[];
  peerAddresses?: string[];
  infoBuffer?: Uint8Array;
  files?: { path: string; name?: string; length: number; offset?: number }[];
  length?: number;
  [k: string]: unknown;
}

export class TorrentInputError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

const MAGNET_MAX = 4096;
export const TORRENT_FILE_MAX = 2 * 1024 * 1024;

/** Parses a magnet link or the bytes of a .torrent file. Throws TorrentInputError with a message fit to show the user. */
export async function parseTorrentInput(input: string | Uint8Array): Promise<ParsedTorrent> {
  if (typeof input === 'string') {
    const m = input.trim();
    if (m.length > MAGNET_MAX) throw new TorrentInputError('magnet_too_long', 'That magnet link is too long.');
    if (!/^magnet:\?/i.test(m) || !/[?&]xt=urn:bt(ih|mh):/i.test(m)) throw new TorrentInputError('invalid_magnet', 'That is not a valid magnet link (it needs an xt=urn:btih: part).');
    if (!/[?&]xt=urn:btih:/i.test(m)) throw new TorrentInputError('unsupported_torrent', 'Only BitTorrent v1 info hashes (xt=urn:btih:) are supported; this link has only a v2 hash.');
    input = m;
  } else if (input.length === 0 || input.length > TORRENT_FILE_MAX) {
    throw new TorrentInputError('invalid_torrent', `A .torrent file must be between 1 byte and ${TORRENT_FILE_MAX / 1024 / 1024} MB.`);
  }
  let parsed: ParsedTorrent;
  try {
    const mod = (await import('parse-torrent')) as unknown as { default: (id: string | Uint8Array) => Promise<ParsedTorrent> };
    parsed = await mod.default(input as never);
  } catch {
    throw new TorrentInputError(typeof input === 'string' ? 'invalid_magnet' : 'invalid_torrent', typeof input === 'string' ? 'That magnet link could not be read.' : 'That file is not a valid .torrent file.');
  }
  // A 20-byte upload is read by the parser as a bare info hash. An uploaded file must really be a .torrent: it has to carry file information.
  if (typeof input !== 'string' && !parsed.infoBuffer && !parsed.files?.length) throw new TorrentInputError('invalid_torrent', 'That file is not a valid .torrent file.');
  if (typeof parsed.infoHash !== 'string' || !/^[0-9a-f]{40}$/i.test(parsed.infoHash)) {
    throw new TorrentInputError('unsupported_torrent', 'Only BitTorrent v1 info hashes (40 hex characters) are supported.');
  }
  return parsed;
}

/** Peer filter in the shape WebTorrent expects (`contains(ip)` is true for addresses that must not be contacted). */
export function peerFilter(allowedCidrs = ''): { contains(ip: string): boolean } {
  const policy = createIpPolicy(allowedCidrs);
  return { contains: (ip) => policy.isBlocked(ip) };
}

export interface TrackerResult { kept: string[]; dropped: { url: string; reason: string }[] }
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultResolve: Resolver = (host) => dns.promises.lookup(host, { all: true });
const MAX_TRACKERS = 8;

/**
 * Keeps only trackers that are safe to talk to. Each is resolved here and must resolve to public addresses only; the address that
 * passed the check replaces the hostname, so a DNS answer that changes afterwards (rebinding) cannot redirect the request.
 * Only http and udp trackers are supported (https/ws trackers would need the hostname for TLS and are dropped).
 */
export async function safeTrackers(urls: readonly string[] | undefined, allowedCidrs = '', resolve: Resolver = defaultResolve): Promise<TrackerResult> {
  const policy = createIpPolicy(allowedCidrs);
  const kept: string[] = [];
  const dropped: TrackerResult['dropped'] = [];
  const seen = new Set<string>();
  for (const raw of urls ?? []) {
    if (kept.length >= MAX_TRACKERS) { dropped.push({ url: raw, reason: 'too many trackers' }); continue; }
    let u: URL;
    try { u = new URL(raw); } catch { dropped.push({ url: raw, reason: 'not a URL' }); continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'udp:') { dropped.push({ url: raw, reason: `${u.protocol.replace(':', '')} trackers are not supported` }); continue; }
    if (u.username || u.password) { dropped.push({ url: raw, reason: 'credentials in a tracker URL' }); continue; }
    if (u.protocol === 'udp:' && !u.port) { dropped.push({ url: raw, reason: 'no port' }); continue; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let ip: string;
    if (isIP(host)) {
      if (policy.isBlocked(host)) { dropped.push({ url: raw, reason: 'private or reserved address' }); continue; }
      ip = host;
    } else {
      let addrs: { address: string; family: number }[];
      try { addrs = await resolve(host); } catch { dropped.push({ url: raw, reason: 'could not be resolved' }); continue; }
      if (!addrs.length || addrs.some((a) => policy.isBlocked(a.address))) { dropped.push({ url: raw, reason: 'resolves to a private or reserved address' }); continue; }
      ip = (addrs.find((a) => a.family === 4) ?? addrs[0]!).address;
    }
    u.hostname = isIP(ip) === 6 ? `[${ip}]` : ip;
    const out = u.toString();
    if (seen.has(out)) continue;
    seen.add(out);
    kept.push(out);
  }
  return { kept, dropped };
}

/** One path segment that is safe to use as a file or folder name on any system. */
export function safeSegment(raw: string): string {
  // eslint-disable-next-line no-control-regex
  let s = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').trim().replace(/[. ]+$/, '');
  if (s === '' || s === '.' || s === '..') s = '_';
  if (Buffer.byteLength(s) > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 20 ? s.slice(dot) : '';
    let base = s.slice(0, s.length - ext.length);
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    s = base + ext;
  }
  return s;
}

export interface TorrentFileInfo { i: number; path: string; size: number; selected: boolean; imported?: boolean }

/** The file list shown to the user and used for the folder layout: every path segment sanitised. */
export function describeFiles(parsedFiles: { path: string; length: number }[]): TorrentFileInfo[] {
  return parsedFiles.map((f, i) => ({
    i, size: f.length, selected: true,
    path: f.path.split(/[\\/]+/).filter((s) => s !== '').map(safeSegment).join('/') || '_',
  }));
}
