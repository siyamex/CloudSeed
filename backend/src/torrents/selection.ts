import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import type { TorrentFileInfo } from './policy.js';

/** null when the chosen files can be downloaded and stored, otherwise the reason (fit to show the user). */
export async function checkSelection(db: Db, config: Pick<Config, 'MAX_FILE_SIZE_BYTES'>, userId: string, files: TorrentFileInfo[]): Promise<{ code: string; message: string } | null> {
  const chosen = files.filter((f) => f.selected);
  if (chosen.length === 0) return { code: 'nothing_selected', message: 'Select at least one file.' };
  const big = chosen.find((f) => f.size > config.MAX_FILE_SIZE_BYTES);
  if (big) return { code: 'file_too_large', message: `"${big.path}" is larger than the maximum file size (${config.MAX_FILE_SIZE_BYTES} bytes). Deselect it.` };
  const total = chosen.reduce((n, f) => n + f.size, 0);
  const q = (await db.query<{ quota_bytes: number; used_bytes: number }>(`SELECT quota_bytes, used_bytes FROM storage_quotas WHERE user_id = $1`, [userId])).rows[0];
  const free = Math.max(0, Number(q?.quota_bytes ?? 0) - Number(q?.used_bytes ?? 0));
  if (total > free) return { code: 'quota_exceeded', message: `The selected files need ${total} bytes but you have ${free} bytes free. Deselect some or free up space.` };
  return null;
}
