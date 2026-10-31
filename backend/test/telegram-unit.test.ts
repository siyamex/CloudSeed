import { describe, expect, it } from 'vitest';
import { loadConfig, telegramLimits } from '../src/config.js';
import { createVault } from '../src/crypto.js';
import { evaluateAccess, parseChatRef } from '../src/routes/telegram.js';
import { MAX_ALBUM, MAX_PARTS, chooseSendAs, messageLink, partName, planTransfer, type Limits } from '../src/telegram/plan.js';

const MiB = 1024 * 1024;
const hosted: Limits = { upload: 50 * MiB, photo: 10 * MiB, part: 45 * MiB, mode: 'hosted' };
const f = (name: string, size: number, mime: string, id = name) => ({ id, name, size, mime });
const opts = (o: Partial<Parameters<typeof planTransfer>[1]> = {}) => {
  let n = 0;
  return { method: 'auto' as const, album: false, split: false, limits: hosted, newKey: () => `album-${++n}`, ...o };
};

describe('limits by deployment mode', () => {
  it('uses 50 MB for the official hosted Bot API and 2000 MB for a self-hosted server', () => {
    const base = { TELEGRAM_MAX_UPLOAD_BYTES: undefined, TELEGRAM_PHOTO_MAX_BYTES: 10 * MiB, TELEGRAM_SPLIT_PART_BYTES: undefined };
    expect(telegramLimits({ ...base, TELEGRAM_API_MODE: 'hosted' })).toMatchObject({ upload: 50 * MiB, photo: 10 * MiB, mode: 'hosted' });
    expect(telegramLimits({ ...base, TELEGRAM_API_MODE: 'self-hosted' })).toMatchObject({ upload: 2000 * MiB, mode: 'self-hosted' });
  });
  it('lets an explicit override win and keeps parts under the limit', () => {
    const l = telegramLimits({ TELEGRAM_API_MODE: 'hosted', TELEGRAM_MAX_UPLOAD_BYTES: 1000, TELEGRAM_PHOTO_MAX_BYTES: 5000, TELEGRAM_SPLIT_PART_BYTES: 5000 });
    expect(l).toMatchObject({ upload: 1000, photo: 1000, part: 1000 });
    expect(telegramLimits({ TELEGRAM_API_MODE: 'hosted', TELEGRAM_MAX_UPLOAD_BYTES: undefined, TELEGRAM_PHOTO_MAX_BYTES: 10 * MiB, TELEGRAM_SPLIT_PART_BYTES: undefined }).part).toBeLessThan(50 * MiB);
  });
});

describe('chooseSendAs', () => {
  it.each([
    ['a.jpg', 'image/jpeg', 1000, 'auto', 'photo'],
    ['a.png', 'image/png', 1000, 'auto', 'photo'],
    ['a.png', 'image/png', 11 * MiB, 'auto', 'document'], // over the 10 MB photo limit
    ['a.gif', 'image/gif', 1000, 'auto', 'document'],
    ['a.webp', 'image/webp', 1000, 'auto', 'document'],
    ['a.mp4', 'video/mp4', 1000, 'auto', 'video'],
    ['a.mkv', 'video/x-matroska', 1000, 'auto', 'document'],
    ['a.mp3', 'audio/mpeg', 1000, 'auto', 'audio'],
    ['a.m4a', 'audio/mp4', 1000, 'auto', 'audio'],
    ['a.flac', 'audio/flac', 1000, 'auto', 'document'], // sendAudio only takes .mp3/.m4a
    ['a.wav', 'audio/wav', 1000, 'auto', 'document'],
    ['a.pdf', 'application/pdf', 1000, 'auto', 'document'],
    ['a.jpg', 'image/jpeg', 1000, 'document', 'document'], // explicit "as file" keeps the original bytes
    ['a.mp4', 'video/mp4', 1000, 'document', 'document'],
  ] as const)('%s (%s, %i B, %s) -> %s', (name, mime, size, method, expected) => {
    expect(chooseSendAs({ name, mime, size }, method, hosted)).toBe(expected);
  });
});

describe('planTransfer', () => {
  it('sends normal files as-is in order', () => {
    const { items, issues } = planTransfer([f('a.pdf', 100, 'application/pdf'), f('b.jpg', 200, 'image/jpeg')], opts());
    expect(issues).toEqual([]);
    expect(items.map((i) => [i.name, i.sendAs, i.albumKey])).toEqual([['a.pdf', 'document', null], ['b.jpg', 'photo', null]]);
  });

  it('rejects empty files (Telegram refuses them)', () => {
    const { issues } = planTransfer([f('e.txt', 0, 'text/plain')], opts());
    expect(issues[0]).toMatchObject({ code: 'empty_file', fileId: 'e.txt' });
  });

  it('reports an oversized file with honest alternatives instead of truncating or pretending', () => {
    const { items, issues } = planTransfer([f('big.iso', 120 * MiB, 'application/octet-stream')], opts());
    expect(items).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('file_too_large');
    expect(issues[0]!.message).toMatch(/official Telegram Bot API/);
    const alt = Object.fromEntries(issues[0]!.alternatives.map((a) => [a.kind, a]));
    expect(alt.split).toMatchObject({ available: true });
    expect(alt.split!.detail).toContain('big.iso.001');
    expect(alt.share_link).toMatchObject({ available: false }); // sharing links do not exist yet, so not offered
  });

  it('names the self-hosted server in the message when running that mode', () => {
    const { issues } = planTransfer([f('big.iso', 3000 * MiB, 'x/y')], opts({ limits: { upload: 2000 * MiB, photo: 10 * MiB, part: 1800 * MiB, mode: 'self-hosted' } }));
    expect(issues[0]!.message).toMatch(/your Bot API server/);
  });

  it('splits only when asked, into contiguous numbered parts that cover every byte exactly once', () => {
    const size = 120 * MiB + 12345;
    const { items, issues } = planTransfer([f('movie.mkv', size, 'video/x-matroska')], opts({ split: true }));
    expect(issues).toEqual([]);
    expect(items).toHaveLength(Math.ceil(size / hosted.part));
    expect(items.map((i) => i.name)).toEqual(items.map((_, i) => partName('movie.mkv', i)));
    expect(items[0]!.name).toBe('movie.mkv.001');
    let at = 0;
    for (const [i, p] of items.entries()) {
      expect(p.offset).toBe(at);
      expect(p.size).toBeLessThanOrEqual(hosted.part);
      expect(p.size).toBeLessThanOrEqual(hosted.upload);
      expect(p.sendAs).toBe('document');
      expect([p.partIndex, p.partCount]).toEqual([i + 1, items.length]);
      at += p.size;
    }
    expect(at).toBe(size);
  });

  it('refuses absurd part counts', () => {
    const { issues } = planTransfer([f('huge.bin', (MAX_PARTS + 5) * hosted.part, 'x/y')], opts({ split: true }));
    expect(issues[0]!.code).toBe('too_many_parts');
  });

  it('does not split files that already fit, even when splitting is enabled', () => {
    const { items } = planTransfer([f('small.zip', 10 * MiB, 'application/zip')], opts({ split: true }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'small.zip', partIndex: null });
  });

  describe('albums', () => {
    const visual = (n: number) => Array.from({ length: n }, (_, i) => f(`p${i}.jpg`, 100, 'image/jpeg'));

    it('groups consecutive photos and videos (they may mix)', () => {
      const { items } = planTransfer([...visual(2), f('v.mp4', 100, 'video/mp4')], opts({ album: true }));
      expect(new Set(items.map((i) => i.albumKey)).size).toBe(1);
      expect(items.every((i) => i.albumKey === 'album-1')).toBe(true);
    });

    it('never mixes documents or audio with other kinds', () => {
      const { items } = planTransfer([
        f('a.jpg', 1, 'image/jpeg'), f('b.jpg', 1, 'image/jpeg'),
        f('c.pdf', 1, 'application/pdf'), f('d.pdf', 1, 'application/pdf'),
        f('e.mp3', 1, 'audio/mpeg'), f('f.mp3', 1, 'audio/mpeg'), f('g.jpg', 1, 'image/jpeg'),
      ], opts({ album: true }));
      expect(items.map((i) => i.albumKey)).toEqual(['album-1', 'album-1', 'album-2', 'album-2', 'album-3', 'album-3', null]); // lone trailing photo is a plain message
    });

    it('caps albums at 10 and leaves a lone remainder as a single message', () => {
      const { items } = planTransfer(visual(MAX_ALBUM + 1), opts({ album: true }));
      expect(items.filter((i) => i.albumKey === 'album-1')).toHaveLength(MAX_ALBUM);
      expect(items[MAX_ALBUM]!.albumKey).toBeNull();
      const two = planTransfer(visual(12), opts({ album: true })).items;
      expect(two.filter((i) => i.albumKey === 'album-2')).toHaveLength(2);
    });

    it('never makes an album of one, and is off by default', () => {
      expect(planTransfer(visual(1), opts({ album: true })).items[0]!.albumKey).toBeNull();
      expect(planTransfer(visual(3), opts()).items.every((i) => i.albumKey === null)).toBe(true);
    });

    it('groups split parts (documents) into albums too', () => {
      const { items } = planTransfer([f('x.bin', 3 * hosted.part, 'x/y')], opts({ album: true, split: true }));
      expect(items).toHaveLength(3);
      expect(new Set(items.map((i) => i.albumKey)).size).toBe(1);
    });
  });
});

describe('message links', () => {
  it('public chats get a public link', () => {
    expect(messageLink({ chatId: -1001, username: 'news', type: 'channel' }, 7)).toEqual({ url: 'https://t.me/news/7', membersOnly: false });
  });
  it('private supergroups/channels get a members-only /c/ link', () => {
    expect(messageLink({ chatId: -1001234567890, username: null, type: 'supergroup' }, 5)).toEqual({ url: 'https://t.me/c/1234567890/5', membersOnly: true });
  });
  it('basic groups and missing ids have no link (Telegram exposes none)', () => {
    expect(messageLink({ chatId: -4242, username: null, type: 'group' }, 5)).toBeNull();
    expect(messageLink({ chatId: -1001234567890, username: null, type: 'channel' }, null)).toBeNull();
  });
});

describe('evaluateAccess (bot permissions in a chat)', () => {
  const ch = (type: 'group' | 'supergroup' | 'channel') => ({ id: -1, type });
  it('channels need an administrator who may post', () => {
    expect(evaluateAccess(ch('channel'), { status: 'administrator', can_post_messages: true }).canSend).toBe(true);
    expect(evaluateAccess(ch('channel'), { status: 'creator' }).canSend).toBe(true);
    const no = evaluateAccess(ch('channel'), { status: 'administrator', can_post_messages: false });
    expect(no.canSend).toBe(false);
    expect(no.problem).toMatch(/Post messages/);
    expect(evaluateAccess(ch('channel'), { status: 'member' }).canSend).toBe(false);
  });
  it('plain members and admins can post in groups', () => {
    for (const status of ['member', 'administrator', 'creator'] as const) expect(evaluateAccess(ch('supergroup'), { status }).canSend).toBe(true);
  });
  it('restricted bots are checked field by field', () => {
    expect(evaluateAccess(ch('group'), { status: 'restricted', can_send_messages: true, can_send_documents: true }).canSend).toBe(true);
    const r = evaluateAccess(ch('group'), { status: 'restricted', can_send_messages: true, can_send_documents: false });
    expect(r.canSend).toBe(false);
    expect(r.problem).toMatch(/documents/);
    expect(evaluateAccess(ch('group'), { status: 'restricted', is_member: false }).canSend).toBe(false);
  });
  it('left and kicked bots cannot send, with different advice', () => {
    expect(evaluateAccess(ch('group'), { status: 'left' }).problem).toMatch(/not a member/);
    expect(evaluateAccess(ch('group'), { status: 'kicked' }).problem).toMatch(/removed/);
  });
  it('records the raw permission facts for display', () => {
    expect(evaluateAccess(ch('channel'), { status: 'administrator', can_post_messages: true }).permissions).toEqual({ status: 'administrator', can_post_messages: true });
  });
});

describe('parseChatRef', () => {
  it.each([
    ['-1001234567890', -1001234567890], ['  -100123456  ', -100123456], ['@mychannel', '@mychannel'], ['mychannel', '@mychannel'],
    ['https://t.me/mychannel', '@mychannel'], ['t.me/mychannel', '@mychannel'] as const,
  ])('%s -> %s', (input, out) => { expect(parseChatRef(input)).toBe(out); });
  it.each(['', 'ab', '@a', '12', 'has space', 'https://t.me/joinchat/AAAA', 'drop;table', '@' + 'x'.repeat(40)])('rejects %j', (input) => {
    expect(parseChatRef(input)).toBeNull();
  });
});

describe('credential vault', () => {
  const cfg = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SESSION_SECRET: '', NODE_ENV: 'test' as const };
  const token = '123456789:AAFakeTokenValueForTestingOnly_12345';

  it('round-trips and never stores the plaintext', () => {
    const v = createVault(cfg);
    const blob = v.encrypt(token, 'owner:1');
    expect(blob.toString('utf8')).not.toContain('AAFake');
    expect(blob.toString('latin1')).not.toContain('123456789');
    expect(v.decrypt(blob, 'owner:1')).toBe(token);
  });
  it('uses a fresh IV every time', () => {
    const v = createVault(cfg);
    expect(v.encrypt(token, 'a').equals(v.encrypt(token, 'a'))).toBe(false);
  });
  it('is bound to its owner: the same blob does not decrypt under another AAD', () => {
    const v = createVault(cfg);
    expect(() => v.decrypt(v.encrypt(token, 'user:1'), 'user:2')).toThrow('unreadable credential');
  });
  it('rejects a different key, tampering and truncation', () => {
    const v = createVault(cfg), other = createVault({ ...cfg, ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') });
    const blob = v.encrypt(token, 'a');
    expect(() => other.decrypt(blob, 'a')).toThrow('unreadable credential');
    const t = Buffer.from(blob); t[t.length - 1]! ^= 1;
    expect(() => v.decrypt(t, 'a')).toThrow('unreadable credential');
    expect(() => v.decrypt(blob.subarray(0, 20), 'a')).toThrow('unreadable credential');
  });
  it('validates the key', () => {
    expect(() => createVault({ ...cfg, ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
    expect(() => createVault({ ENCRYPTION_KEY: '', SESSION_SECRET: '', NODE_ENV: 'production' })).toThrow(/required/);
    expect(createVault({ ENCRYPTION_KEY: '', SESSION_SECRET: 'dev', NODE_ENV: 'development' }).encrypt('x', 'a').length).toBeGreaterThan(29);
  });
});

describe('production configuration', () => {
  const ok = {
    NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: 'i', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REDIRECT_URI: 'https://c.example/cb',
    PUBLIC_URL: 'https://c.example', DATABASE_URL: 'postgres://app:strongpw@db/app', ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  it('requires a 32-byte ENCRYPTION_KEY', () => {
    expect(loadConfig(ok as never).TELEGRAM_API_MODE).toBe('hosted');
    expect(() => loadConfig({ ...ok, ENCRYPTION_KEY: '' } as never)).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...ok, ENCRYPTION_KEY: Buffer.alloc(8).toString('base64') } as never)).toThrow(/ENCRYPTION_KEY/);
  });
  it('requires https for the hosted Bot API but allows http for a self-hosted server on a private network', () => {
    expect(() => loadConfig({ ...ok, TELEGRAM_API_BASE: 'http://api.telegram.org' } as never)).toThrow(/https/);
    expect(loadConfig({ ...ok, TELEGRAM_API_MODE: 'self-hosted', TELEGRAM_API_BASE: 'http://telegram-api:8081' } as never).TELEGRAM_API_MODE).toBe('self-hosted');
  });
});

describe('boolean environment parsing (zod 4 defaults must not leak strings)', () => {
  it('uses real booleans for defaults', () => {
    const c = loadConfig({} as never);
    expect(c.S3_FORCE_PATH_STYLE).toBe(false); // a leaked 'false' string would be truthy and force path-style S3
    expect(c.TELEGRAM_ENABLED).toBe(true);
  });
  it('parses explicit true/false strings and rejects anything else', () => {
    expect(loadConfig({ S3_FORCE_PATH_STYLE: 'true', TELEGRAM_ENABLED: 'false' } as never)).toMatchObject({ S3_FORCE_PATH_STYLE: true, TELEGRAM_ENABLED: false });
    expect(() => loadConfig({ TELEGRAM_ENABLED: 'yes' } as never)).toThrow(/TELEGRAM_ENABLED/);
  });
});
