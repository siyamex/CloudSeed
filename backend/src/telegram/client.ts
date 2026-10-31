import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';

/** Telegram answered with ok:false (or a non-JSON error page). */
export class TelegramApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly description: string,
    public readonly retryAfter?: number,
    public readonly migrateTo?: number,
  ) { super(description); }
}

/** The request failed without a Telegram answer. */
export class TelegramNetworkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    /** True when the whole request body had been handed to an established connection: Telegram may have processed it. */
    public readonly possiblyDelivered: boolean,
  ) { super(message); }
}

/** Reading the source file failed while uploading; nothing complete was sent. */
export class TelegramSourceError extends Error {
  constructor(message: string, public readonly cause2?: unknown) { super(message); }
}

export interface ApiConfig { base: string; token: string }

// Errors deliberately never include the request URL: it contains the bot token.
const methodUrl = (c: ApiConfig, method: string) => new URL(`${c.base.replace(/\/+$/, '')}/bot${c.token}/${method}`);

function parseAnswer(status: number, text: string): unknown {
  let body: { ok?: boolean; result?: unknown; description?: string; error_code?: number; parameters?: { retry_after?: number; migrate_to_chat_id?: number } } | null = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (body?.ok === true) return body.result;
  if (!body) throw new TelegramApiError(status, `non-JSON response (HTTP ${status})`);
  throw new TelegramApiError(body.error_code ?? status, body.description ?? `HTTP ${status}`, body.parameters?.retry_after, body.parameters?.migrate_to_chat_id);
}

/** A plain JSON method call (getMe, getChat, sendMessage, ...). */
export async function call<T = unknown>(c: ApiConfig, method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(methodUrl(c, method), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const code = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name;
    throw new TelegramNetworkError(`Could not reach the Telegram API (${code})`, code, true);
  }
  return parseAnswer(res.status, await res.text()) as T;
}

export interface UploadPart {
  field: string;
  filename: string;
  contentType: string;
  /** Exact number of bytes `open()` will yield. */
  size: number;
  open(): Promise<Readable>;
}

export interface UploadOptions extends ApiConfig {
  method: string;
  fields: Record<string, string>;
  parts: UploadPart[];
  connectTimeoutMs: number;
  /** Abort if no body bytes could be written for this long. */
  idleTimeoutMs: number;
  /** After the full body is sent, how long to wait for Telegram's answer. */
  responseTimeoutMs: number;
  signal?: AbortSignal;
  /** Called as bytes of part `index` are written. */
  onProgress?(index: number, bytes: number): void;
  /** Called once the whole body has been handed to the connection; from then on the outcome is only knowable from Telegram's answer. */
  onBodySent?(): void;
}

const quote = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/"/g, '%22');

/**
 * Streams a multipart/form-data request without buffering files (Content-Length is computed up front).
 * Resolves with the API `result`; rejects with TelegramApiError / TelegramNetworkError / TelegramSourceError.
 */
export function upload<T = unknown>(o: UploadOptions): Promise<T> {
  const boundary = `----cloudseed${randomBytes(12).toString('hex')}`;
  const url = methodUrl(o, o.method);
  const lib = url.protocol === 'https:' ? https : http;

  type Segment = { buf: Buffer } | { part: UploadPart; index: number };
  const segments: Segment[] = [];
  for (const [k, v] of Object.entries(o.fields)) {
    segments.push({ buf: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(k)}"\r\n\r\n${v}\r\n`) });
  }
  o.parts.forEach((part, index) => {
    segments.push({ buf: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(part.field)}"; filename="${quote(part.filename)}"\r\nContent-Type: ${part.contentType}\r\n\r\n`) });
    segments.push({ part, index });
    segments.push({ buf: Buffer.from('\r\n') });
  });
  segments.push({ buf: Buffer.from(`--${boundary}--\r\n`) });
  const total = segments.reduce((n, s) => n + ('buf' in s ? s.buf.length : s.part.size), 0);

  return new Promise<T>((resolve, reject) => {
    let connected = false, bodyDone = false, settled = false;
    let idle: NodeJS.Timeout | undefined, connectT: NodeJS.Timeout | undefined, respT: NodeJS.Timeout | undefined;
    const clear = () => { clearTimeout(idle); clearTimeout(connectT); clearTimeout(respT); o.signal?.removeEventListener('abort', onAbort); };
    const finish = (fn: () => void) => { if (settled) return; settled = true; clear(); fn(); };
    const fail = (e: Error) => finish(() => { req.destroy(); reject(e); });
    const net = (msg: string, code: string) => new TelegramNetworkError(msg, code, bodyDone && connected);
    const onAbort = () => fail(net('Upload aborted', 'aborted'));

    const req = lib.request(url, { method: 'POST', agent: false, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': total } });
    connectT = setTimeout(() => { if (!connected) fail(net('Connection to the Telegram API timed out', 'connect_timeout')); }, o.connectTimeoutMs);
    req.on('socket', (s) => {
      if (!s.connecting) connected = true;
      else s.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(connectT); });
    });
    req.on('error', (e: NodeJS.ErrnoException) => fail(net(`Connection error (${e.code ?? e.message})`, e.code ?? 'network_error')));
    req.on('response', (res) => {
      clearTimeout(respT);
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { n += c.length; if (n < 1_000_000) chunks.push(c); });
      res.on('error', (e) => fail(net(`Connection error (${(e as NodeJS.ErrnoException).code ?? e.message})`, 'response_error')));
      res.on('end', () => finish(() => {
        try { resolve(parseAnswer(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8')) as T); } catch (e) { reject(e); }
      }));
    });
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) return onAbort();

    const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => fail(net('Upload stalled (no progress)', 'idle_timeout')), o.idleTimeoutMs); };
    const write = (chunk: Buffer) => new Promise<void>((res, rej) => {
      if (req.destroyed) return rej(new Error('request closed'));
      const ok = req.write(chunk, (err) => (err ? rej(err) : undefined));
      if (ok) res(); else req.once('drain', () => res());
    });

    void (async () => {
      try {
        armIdle();
        for (const seg of segments) {
          if (settled) return;
          if ('buf' in seg) { await write(seg.buf); armIdle(); continue; }
          let stream: Readable;
          try { stream = await seg.part.open(); } catch (e) { throw new TelegramSourceError('Could not read the file from storage', e); }
          let sent = 0;
          try {
            for await (const chunk of stream) {
              const b = chunk as Buffer;
              sent += b.length;
              if (sent > seg.part.size) throw new TelegramSourceError('The stored file is larger than expected');
              await write(b); armIdle();
              o.onProgress?.(seg.index, sent);
            }
          } catch (e) {
            stream.destroy();
            if (e instanceof TelegramSourceError) throw e;
            if (settled) return;
            throw new TelegramSourceError('Reading the file from storage failed', e);
          }
          if (sent !== seg.part.size) throw new TelegramSourceError('The stored file is smaller than expected');
        }
        if (settled) return;
        clearTimeout(idle);
        req.end();
        bodyDone = true; // from here on Telegram may have processed the request
        o.onBodySent?.();
        respT = setTimeout(() => fail(net('Telegram did not answer in time', 'response_timeout')), o.responseTimeoutMs);
      } catch (e) {
        if (!settled) fail(e instanceof Error ? e : new Error(String(e)));
      }
    })();
  });
}

// ---- typed helpers ----

export interface TgUser { id: number; is_bot: boolean; username?: string; first_name: string }
export interface TgChat { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string }
export interface TgMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  can_post_messages?: boolean; is_member?: boolean;
  can_send_messages?: boolean; can_send_documents?: boolean; can_send_photos?: boolean; can_send_videos?: boolean; can_send_audios?: boolean;
}
export interface TgMessage { message_id: number; chat: TgChat }

export const getMe = (c: ApiConfig) => call<TgUser>(c, 'getMe');
export const getChat = (c: ApiConfig, chat: string | number) => call<TgChat>(c, 'getChat', { chat_id: chat });
export const getChatMember = (c: ApiConfig, chat: number, user: number) => call<TgMember>(c, 'getChatMember', { chat_id: chat, user_id: user });
export const sendMessage = (c: ApiConfig, chat: number, text: string) => call<TgMessage>(c, 'sendMessage', { chat_id: chat, text });
