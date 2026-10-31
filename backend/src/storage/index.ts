import type { Config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { StorageAdapter } from './types.js';

export interface Storages {
  /** Adapter used for new writes. */
  storage: StorageAdapter;
  /** Every configured adapter, so existing files keep working after a backend switch. */
  storages: Partial<Record<StorageAdapter['kind'], StorageAdapter>>;
  adapterFor(kind: string): StorageAdapter | undefined;
}

export function createStorages(config: Config): Storages {
  const local = new LocalStorage(config.LOCAL_STORAGE_ROOT, config.LOCAL_TMP_DIR);
  const s3 = config.STORAGE_BACKEND === 's3'
    ? new S3Storage({
        endpoint: config.S3_ENDPOINT, region: config.S3_REGION, bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        forcePathStyle: config.S3_FORCE_PATH_STYLE, keyPrefix: config.S3_KEY_PREFIX,
      })
    : undefined;
  const storages = { local, ...(s3 ? { s3 } : {}) };
  return { storage: s3 ?? local, storages, adapterFor: (kind) => storages[kind as StorageAdapter['kind']] };
}
