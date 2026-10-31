import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

/** The administrator's switch (Administration > Settings) wins; without one the TORRENT_ENABLED environment variable decides. */
export async function torrentsEnabled(db: Db, config: Pick<Config, 'TORRENT_ENABLED'>): Promise<boolean> {
  const r = await db.query<{ value: unknown }>(`SELECT value FROM application_settings WHERE key = 'torrents_enabled'`);
  const v = r.rows[0]?.value;
  return typeof v === 'boolean' ? v : config.TORRENT_ENABLED;
}
