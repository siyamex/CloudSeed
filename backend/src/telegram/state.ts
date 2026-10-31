import type { Db } from '../db/index.js';

/**
 * Derives a transfer's state from its files and notifies the owner once when it reaches a final state.
 * Shared by the API (cancel/retry) and the engine, so both always agree.
 */
export async function recomputeTransfer(db: Db, transferId: string) {
  const c = (await db.query<{ total: number; queued: number; uploading: number; sent: number; failed: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'queued')::int AS queued,
            count(*) FILTER (WHERE state = 'uploading')::int AS uploading, count(*) FILTER (WHERE state = 'sent')::int AS sent,
            count(*) FILTER (WHERE state = 'failed')::int AS failed
       FROM telegram_transfer_files WHERE transfer_id = $1`, [transferId])).rows[0]!;
  let state: string;
  if (c.uploading > 0) state = 'uploading';
  else if (c.queued > 0) state = c.sent + c.failed > 0 ? 'uploading' : 'queued';
  else if (c.sent === c.total) state = 'sent';
  else if (c.sent > 0) state = 'partial';
  else if (c.failed > 0) state = 'failed';
  else state = 'cancelled';
  const final = ['sent', 'partial', 'failed', 'cancelled'].includes(state);
  const prev = (await db.query<{ state: string; user_id: string; destination_title: string }>(
    `UPDATE telegram_transfers t SET state = $2, updated_at = now(), finished_at = CASE WHEN $3 THEN COALESCE(finished_at, now()) ELSE NULL END
       FROM (SELECT state, user_id, destination_title FROM telegram_transfers WHERE id = $1) o
      WHERE t.id = $1 RETURNING o.state, o.user_id, o.destination_title`, [transferId, state, final])).rows[0];
  if (!prev || prev.state === state) return state;
  const note = (kind: string, title: string, body: string) =>
    db.query(`INSERT INTO notifications (user_id, kind, title, body) VALUES ($1, $2, $3, $4)`, [prev.user_id, kind, title, body.slice(0, 500)]).catch(() => undefined);
  if (state === 'sent') await note('telegram_transfer_completed', 'Sent to Telegram', `${c.total} file(s) sent to ${prev.destination_title}`);
  else if (state === 'failed' || state === 'partial') {
    await note('telegram_transfer_failed', state === 'partial' ? 'Telegram transfer partly failed' : 'Telegram transfer failed',
      `${c.failed} of ${c.total} file(s) could not be sent to ${prev.destination_title}`);
  }
  return state;
}
