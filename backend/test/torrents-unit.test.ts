import { createHash } from 'node:crypto';
import path from 'node:path';
import bencode from 'bencode';
import { describe, expect, it } from 'vitest';
import { createIpPolicy } from '../src/downloads/ssrf.js';
import { TorrentInputError, describeFiles, parseTorrentInput, peerFilter, safeSegment, safeTrackers } from '../src/torrents/policy.js';

const HASH = 'ab'.repeat(20);

/** A syntactically valid .torrent with the given file entries (the data itself does not exist: only its description is tested). */
function craft(name: string, files: { path: string[]; length: number }[], extra: Record<string, unknown> = {}): Buffer {
  const total = files.reduce((n, f) => n + f.length, 0);
  const pieceLength = 16384;
  const pieces = Buffer.alloc(Math.max(1, Math.ceil(total / pieceLength)) * 20, 1);
  const info = files.length === 1 && files[0]!.path.length === 1 && name === files[0]!.path[0]
    ? { name, length: files[0]!.length, 'piece length': pieceLength, pieces }
    : { name, files: files.map((f) => ({ length: f.length, path: f.path })), 'piece length': pieceLength, pieces };
  return Buffer.from(bencode.encode({ info, ...extra }));
}

describe('reading what the user pasted or uploaded', () => {
  it('accepts a normal magnet link and reads its parts', async () => {
    const p = await parseTorrentInput(`magnet:?xt=urn:btih:${HASH}&dn=My%20File&tr=udp%3A%2F%2Ftracker.example.org%3A6969&x.pe=203.0.113.5:6881`);
    expect(p.infoHash).toBe(HASH);
    expect(p.name).toBe('My File');
    expect(p.announce).toEqual(['udp://tracker.example.org:6969']);
    expect(p.peerAddresses).toEqual(['203.0.113.5:6881']);
  });

  it.each([
    ['not a magnet', 'https://example.com/file.torrent', 'invalid_magnet'],
    ['no info hash', 'magnet:?dn=hello', 'invalid_magnet'],
    ['garbage hash', 'magnet:?xt=urn:btih:zzzz', 'invalid_magnet'],
    ['too long', `magnet:?xt=urn:btih:${HASH}&dn=${'a'.repeat(5000)}`, 'magnet_too_long'],
    ['v2-only', `magnet:?xt=urn:btmh:1220${'cd'.repeat(32)}`, 'unsupported_torrent'],
  ])('rejects %s', async (_n, input, code) => {
    await expect(parseTorrentInput(input)).rejects.toMatchObject({ code });
    await expect(parseTorrentInput(input)).rejects.toBeInstanceOf(TorrentInputError);
  });

  it('rejects files that are not torrents, empty, or over the size limit', async () => {
    await expect(parseTorrentInput(Buffer.from('this is not bencoded'))).rejects.toMatchObject({ code: 'invalid_torrent' });
    await expect(parseTorrentInput(Buffer.alloc(0))).rejects.toMatchObject({ code: 'invalid_torrent' });
    await expect(parseTorrentInput(Buffer.alloc(3 * 1024 * 1024, 1))).rejects.toMatchObject({ code: 'invalid_torrent' });
    await expect(parseTorrentInput(Buffer.from(bencode.encode({ hello: 'world' })))).rejects.toMatchObject({ code: 'invalid_torrent' });
  });

  it('reads a real .torrent and lists its files with sanitised paths', async () => {
    const buf = craft('Pack', [{ path: ['dir', 'a.txt'], length: 5 }, { path: ['dir', 'sub', 'b:?.txt'], length: 7 }]);
    const p = await parseTorrentInput(buf);
    expect(p.files).toHaveLength(2);
    expect(describeFiles(p.files!)).toEqual([
      { i: 0, path: 'Pack/dir/a.txt', size: 5, selected: true },
      { i: 1, path: 'Pack/dir/sub/b__.txt', size: 7, selected: true },
    ]);
  });

  it('cannot be used to write outside the download folder: ".." and absolute paths in a torrent stay inside', async () => {
    const root = path.resolve('/srv/scratch/job');
    // the engine builds the location with path.join (never path.resolve, which treats a "C:" segment as a new drive) and then checks the real path
    const buf = craft('evil', [
      { path: ['..', '..', 'etc', 'passwd'], length: 4 },
      { path: ['/abs', 'x'], length: 4 },
      { path: ['a', '..', '..', '..', 'y'], length: 4 },
      { path: ['C:', 'Windows', 'z'], length: 4 },
    ]);
    const p = await parseTorrentInput(buf);
    for (const f of p.files!) {
      const segs = f.path.split(/[\\/]+/);
      expect(segs).not.toContain('..');
      expect(path.join(root, ...segs.filter(Boolean)).startsWith(root + path.sep)).toBe(true);
    }
    for (const d of describeFiles(p.files!)) {
      expect(d.path).not.toMatch(/(^|\/)\.\.(\/|$)/);
      expect(d.path).not.toMatch(/^[/\\]|:/);
    }
  });
});

describe('which peers may be contacted', () => {
  const f = peerFilter();
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', 'fe80::1', 'fc00::5', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '[::1]', 'not-an-ip',
  ])('blocks %s', (ip) => expect(f.contains(ip)).toBe(true));
  it.each(['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '172.32.0.1'])('allows %s', (ip) => expect(f.contains(ip)).toBe(false));
  it('lets an operator open a specific network (for a lab) without opening the rest', () => {
    const lab = peerFilter('10.20.0.0/16, 127.0.0.1');
    expect(lab.contains('10.20.5.5')).toBe(false);
    expect(lab.contains('127.0.0.1')).toBe(false);
    expect(lab.contains('10.21.0.1')).toBe(true);
    expect(lab.contains('192.168.0.1')).toBe(true);
  });
  it('uses the same rule as the download guard', () => {
    const g = createIpPolicy('');
    for (const ip of ['10.0.0.1', '8.8.8.8', '::1']) expect(f.contains(ip)).toBe(g.isBlocked(ip));
  });
});

describe('which trackers may be asked', () => {
  const dnsTable: Record<string, string[]> = {
    'tracker.example.org': ['93.184.216.34'], 'multi.example.org': ['93.184.216.35', '10.0.0.5'], 'internal.example.org': ['192.168.1.10'],
    'meta.example.org': ['169.254.169.254'], 'v6.example.org': ['2606:4700:4700::1111'], 'dup.example.org': ['93.184.216.40'],
  };
  const resolve = async (h: string) => {
    if (!dnsTable[h]) throw new Error('ENOTFOUND');
    return dnsTable[h]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

  it('keeps public trackers and pins the hostname to the address that was checked', async () => {
    const r = await safeTrackers(['udp://tracker.example.org:6969/announce', 'http://tracker.example.org/announce?x=1', 'http://v6.example.org:8080/a'], '', resolve);
    expect(r.kept).toEqual(['udp://93.184.216.34:6969/announce', 'http://93.184.216.34/announce?x=1', 'http://[2606:4700:4700::1111]:8080/a']);
    expect(r.dropped).toEqual([]);
  });

  it('drops anything that points inside the network, however it is spelled', async () => {
    const r = await safeTrackers([
      'http://127.0.0.1:8080/announce', 'http://localhost/announce', 'udp://10.0.0.1:6969', 'http://[::1]/a', 'http://169.254.169.254/latest/meta-data',
      'http://internal.example.org/announce', 'http://meta.example.org/', 'http://multi.example.org/announce', 'http://0x7f.1/a', 'http://2130706433/a',
    ], '', resolve);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(10);
  });

  it('drops unsupported or malformed entries', async () => {
    const r = await safeTrackers(['https://tracker.example.org/announce', 'wss://tracker.example.org', 'udp://tracker.example.org/announce', 'ftp://tracker.example.org', 'nonsense', 'http://user:pw@tracker.example.org/a', 'http://nowhere.example.org/a'], '', resolve);
    expect(r.kept).toEqual([]);
    expect(r.dropped.map((d) => d.reason)).toEqual([
      'https trackers are not supported', 'wss trackers are not supported', 'no port', 'ftp trackers are not supported', 'not a URL', 'credentials in a tracker URL', 'could not be resolved',
    ]);
  });

  it('removes duplicates and keeps at most 8', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `udp://tracker.example.org:${7000 + i}`);
    expect((await safeTrackers(many, '', resolve)).kept).toHaveLength(8);
    expect((await safeTrackers(['udp://dup.example.org:1', 'udp://dup.example.org:1'], '', resolve)).kept).toEqual(['udp://93.184.216.40:1']);
    expect((await safeTrackers(undefined, '', resolve)).kept).toEqual([]);
  });

  it('honours the operator allow-list', async () => {
    const r = await safeTrackers(['http://internal.example.org/announce'], '192.168.1.0/24', resolve);
    expect(r.kept).toEqual(['http://192.168.1.10/announce']);
  });
});

describe('names taken from a torrent', () => {
  it.each([
    ['normal.txt', 'normal.txt'], ['a/b', 'a_b'], ['..', '_'], ['.', '_'], ['', '_'], ['con?.txt', 'con_.txt'], ['x\u0000y', 'x_y'], ['trailing. . ', 'trailing'],
    ['<script>', '_script_'], ['back\\slash', 'back_slash'],
  ])('%j -> %j', (input, out) => expect(safeSegment(input)).toBe(out));

  it('keeps long names within the filesystem limit and keeps the extension', () => {
    const s = safeSegment(`${'é'.repeat(300)}.mkv`);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(200);
    expect(s.endsWith('.mkv')).toBe(true);
  });

  it('gives the same info hash a .torrent and its magnet link would', async () => {
    const buf = craft('same.bin', [{ path: ['same.bin'], length: 10 }]);
    const infoHash = (await parseTorrentInput(buf)).infoHash;
    expect(infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect((await parseTorrentInput(`magnet:?xt=urn:btih:${infoHash}`)).infoHash).toBe(infoHash);
    void createHash;
  });
});
