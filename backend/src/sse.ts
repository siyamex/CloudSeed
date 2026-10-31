import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

export interface SseSource<Row extends { id: string; updated_at: string }> {
  userId: string;
  /** Rows of this user changed after `since` (a timestamp string), oldest first. */
  fetch(since: string): Promise<Row[]>;
  toEvent(row: Row): unknown;
  eventName: string;
  /** Current database time minus a small overlap, used as the initial cursor. */
  now(): Promise<string>;
}

/**
 * Creates a Server-Sent-Events streamer for one resource type. Each stream is bound to the authenticated user
 * (the caller passes their id), capped per user, de-duplicated per row, and closed on server shutdown.
 */
export function createSse(app: FastifyInstance, perUserLimit = 5) {
  const open = new Map<string, number>();
  const closers = new Set<() => void>();
  app.addHook('onClose', async () => { for (const c of [...closers]) c(); });

  return async function stream<Row extends { id: string; updated_at: string }>(req: FastifyRequest, reply: FastifyReply, src: SseSource<Row>) {
    const key = `${src.eventName}:${src.userId}`;
    if ((open.get(key) ?? 0) >= perUserLimit) throw new HttpError(429, 'too_many_streams', 'Too many open event streams');
    open.set(key, (open.get(key) ?? 0) + 1);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff', 'x-request-id': req.id,
    });
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true; closers.delete(finish);
      open.set(key, Math.max(0, (open.get(key) ?? 1) - 1));
      raw.end();
    };
    closers.add(finish);
    req.raw.on('close', finish);

    const send = (event: string, data: unknown) => { if (!closed) raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('ready', { at: new Date().toISOString() });

    // Poll with a small overlap window and de-duplicate per row so commit-order skew cannot drop an update.
    let since = await src.now();
    const sent = new Map<string, string>();
    let idleTicks = 0;
    while (!closed) {
      try {
        const rows = await src.fetch(since);
        let n = 0;
        for (const r of rows) {
          if (sent.get(r.id) === r.updated_at) continue;
          sent.set(r.id, r.updated_at); n++;
          send(src.eventName, src.toEvent(r));
          if (r.updated_at > since) since = r.updated_at;
        }
        if (sent.size > 2000) sent.clear();
        idleTicks = n ? 0 : idleTicks + 1;
        if (idleTicks >= 15) { if (!closed) raw.write(': keepalive\n\n'); idleTicks = 0; }
      } catch (err) { req.log.warn({ err }, 'sse poll failed'); }
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
}
