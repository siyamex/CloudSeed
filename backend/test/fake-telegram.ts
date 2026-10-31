import { Busboy } from '@fastify/busboy';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FakeChat { id: number; type: 'group' | 'supergroup' | 'channel' | 'private'; title?: string; username?: string }
export interface FakeMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  can_post_messages?: boolean; is_member?: boolean; can_send_messages?: boolean; can_send_documents?: boolean;
}
export interface SentFile { field: string; filename: string; contentType: string; size: number; sha256: string }
export interface SentRecord { method: string; chatId: number; fields: Record<string, string>; files: SentFile[]; messageIds: number[]; at: number }

export type Failure =
  | { method?: string; times?: number; kind: 'status'; status: number; description: string; parameters?: Record<string, unknown> }
  | { method?: string; times?: number; kind: 'reset-after-body' }
  | { method?: string; times?: number; kind: 'hang-after-body' };

/**
 * A stand-in for the Telegram Bot API that really parses multipart uploads (so the client's streaming encoder is
 * verified byte-for-byte) and enforces the documented album and permission rules.
 */
export async function startFakeTelegram(opts: { maxFileBytes?: number; latencyMs?: number } = {}) {
  const bots = new Map<string, { id: number; username: string }>();
  const chats = new Map<number, FakeChat>();
  const members = new Map<string, FakeMember>();
  const counters = new Map<number, number>();
  const sent: SentRecord[] = [];
  const calls: { method: string; at: number }[] = [];
  /** Requests whose whole body has been received (calls[] is recorded when the headers arrive). */
  const received: { method: string; at: number }[] = [];
  const failures: (Failure & { left: number })[] = [];
  const sockets = new Set<Socket>();
  let latency = opts.latencyMs ?? 0;

  const server = createServer((req, res) => void handle(req, res));
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const err = (res: ServerResponse, code: number, description: string, parameters?: unknown) =>
    reply(res, code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });

  async function readBody(req: IncomingMessage): Promise<{ fields: Record<string, string>; files: SentFile[] }> {
    const ct = req.headers['content-type'] ?? '';
    if (ct.startsWith('multipart/form-data')) {
      return new Promise((resolve, reject) => {
        const fields: Record<string, string> = {};
        const files: SentFile[] = [];
        const bb = new Busboy({ headers: req.headers as never, defCharset: 'utf8' } as never);
        bb.on('field', (name: string, value: string) => { fields[name] = value; });
        bb.on('file', (name: string, stream: NodeJS.ReadableStream, filename: string, _enc: string, mimetype: string) => {
          const h = createHash('sha256'); let size = 0;
          stream.on('data', (c: Buffer) => { size += c.length; h.update(c); });
          stream.on('end', () => files.push({ field: name, filename, contentType: mimetype, size, sha256: h.digest('hex') }));
        });
        bb.on('finish', () => resolve({ fields, files }));
        bb.on('error', reject);
        req.pipe(bb as never);
      });
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const txt = Buffer.concat(chunks).toString('utf8');
    const j = txt ? JSON.parse(txt) : {};
    return { fields: Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])), files: [] };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    if (!m) return err(res, 404, 'Not Found');
    const [, token, method] = m as unknown as [string, string, string];
    calls.push({ method, at: Date.now() });
    const bot = bots.get(token);
    const body = await readBody(req).catch(() => null);
    if (!body) return err(res, 400, 'Bad Request: could not parse the request');
    received.push({ method, at: Date.now() });
    if (!bot) return err(res, 401, 'Unauthorized');

    const f = failures.find((x) => x.left > 0 && (!x.method || x.method === method));
    if (f) {
      f.left--;
      if (f.kind === 'reset-after-body') return void req.socket.destroy();
      if (f.kind === 'hang-after-body') return;
      return err(res, f.status, f.description, f.parameters);
    }
    if (latency) await new Promise((r) => setTimeout(r, latency));

    const chatRef = body.fields.chat_id;
    const resolveChat = () => {
      if (!chatRef) return undefined;
      if (chatRef.startsWith('@')) return [...chats.values()].find((c) => c.username?.toLowerCase() === chatRef.slice(1).toLowerCase());
      return chats.get(Number(chatRef));
    };

    if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: bot.id, is_bot: true, username: bot.username, first_name: `Bot ${bot.username}` } });
    if (method === 'getChat') {
      const c = resolveChat();
      if (!c) return err(res, 400, 'Bad Request: chat not found');
      return reply(res, 200, { ok: true, result: c });
    }
    if (method === 'getChatMember') {
      const c = resolveChat();
      const mem = c && members.get(`${c.id}:${body.fields.user_id}`);
      if (!c || !mem) return err(res, 400, 'Bad Request: chat not found');
      return reply(res, 200, { ok: true, result: mem });
    }

    const c = resolveChat();
    if (!c) return err(res, 400, 'Bad Request: chat not found');
    const mem = members.get(`${c.id}:${bot.id}`);
    if (!mem || mem.status === 'left' || mem.status === 'kicked') return err(res, 403, `Forbidden: bot was kicked from the ${c.type} chat`);
    if (c.type === 'channel' && !(mem.status === 'creator' || (mem.status === 'administrator' && mem.can_post_messages))) {
      return err(res, 400, 'Bad Request: not enough rights to send messages to the chat');
    }
    const nextId = () => { const n = (counters.get(c.id) ?? 100) + 1; counters.set(c.id, n); return n; };
    const record = (ids: number[]) => sent.push({ method, chatId: c.id, fields: body.fields, files: body.files, messageIds: ids, at: Date.now() });
    const msg = (id: number) => ({ message_id: id, chat: c });

    if (method === 'sendMessage') { const id = nextId(); record([id]); return reply(res, 200, { ok: true, result: msg(id) }); }

    if (['sendDocument', 'sendPhoto', 'sendVideo', 'sendAudio'].includes(method)) {
      const mains = body.files.filter((x) => x.field !== 'thumb');
      const file = mains[0];
      if (!file || mains.length !== 1) return err(res, 400, 'Bad Request: there is no file in the request');
      const thumb = body.files.find((x) => x.field === 'thumb');
      if (body.fields.thumbnail && !thumb) return err(res, 400, 'Bad Request: wrong thumbnail: attach://thumb was not uploaded');
      if (thumb && (thumb.size > 200 * 1024 || thumb.contentType !== 'image/jpeg')) return err(res, 400, 'Bad Request: wrong thumbnail');
      if (file.size === 0) return err(res, 400, 'Bad Request: file must be non-empty');
      if (opts.maxFileBytes && file.size > opts.maxFileBytes) return err(res, 413, 'Request Entity Too Large');
      if (method === 'sendPhoto' && /badphoto/.test(file.filename)) return err(res, 400, 'Bad Request: PHOTO_INVALID_DIMENSIONS');
      if (body.fields.caption && body.fields.caption.length > 1024) return err(res, 400, 'Bad Request: message caption is too long');
      const id = nextId(); record([id]);
      return reply(res, 200, { ok: true, result: msg(id) });
    }

    if (method === 'sendMediaGroup') {
      let media: { type: string; media: string; caption?: string }[];
      try { media = JSON.parse(body.fields.media ?? ''); } catch { return err(res, 400, 'Bad Request: media is not valid JSON'); }
      if (!Array.isArray(media) || media.length < 2 || media.length > 10) return err(res, 400, 'Bad Request: media group must include 2-10 items');
      const types = new Set(media.map((x) => (x.type === 'photo' || x.type === 'video' ? 'visual' : x.type)));
      if (types.size > 1) return err(res, 400, 'Bad Request: Documents and audio files can be only grouped in an album with messages of the same type');
      for (const x of media) {
        const field = x.media.replace('attach://', '');
        const file = body.files.find((y) => y.field === field);
        if (!file) return err(res, 400, 'Bad Request: wrong file identifier/HTTP URL specified');
        if (opts.maxFileBytes && file.size > opts.maxFileBytes) return err(res, 413, 'Request Entity Too Large');
      }
      const ids = media.map(() => nextId()); record(ids);
      return reply(res, 200, { ok: true, result: ids.map(msg) });
    }
    return err(res, 404, `Not Found: method ${method} is not implemented by the fake`);
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, port, sent, calls, received,
    addBot(token: string, bot: { id: number; username: string }) { bots.set(token, bot); },
    removeBot(token: string) { bots.delete(token); },
    addChat(chat: FakeChat, membership: Record<number, FakeMember> = {}) {
      chats.set(chat.id, chat);
      for (const [botId, mem] of Object.entries(membership)) members.set(`${chat.id}:${botId}`, mem);
    },
    setMember(chatId: number, botId: number, mem: FakeMember | null) { if (mem) members.set(`${chatId}:${botId}`, mem); else members.delete(`${chatId}:${botId}`); },
    migrate(oldId: number, chat: FakeChat) { chats.delete(oldId); chats.set(chat.id, chat); },
    fail(f: Failure) { failures.push({ ...f, left: f.times ?? 1 } as never); },
    clearFailures() { failures.length = 0; },
    setLatency(ms: number) { latency = ms; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}
export type FakeTelegram = Awaited<ReturnType<typeof startFakeTelegram>>;
