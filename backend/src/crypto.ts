import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';

export interface Vault {
  /** AES-256-GCM. `aad` binds the ciphertext to its owner so it cannot be moved to another row. */
  encrypt(plain: string, aad: string): Buffer;
  decrypt(blob: Uint8Array, aad: string): string;
}

const VERSION = 1;

export function createVault(config: Pick<Config, 'ENCRYPTION_KEY' | 'SESSION_SECRET' | 'NODE_ENV'>): Vault {
  let key: Buffer;
  if (config.ENCRYPTION_KEY) {
    key = Buffer.from(config.ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  } else if (config.NODE_ENV !== 'production') {
    // Development/test convenience only; production refuses to start without a real key (see loadConfig).
    key = createHash('sha256').update(`cloudseed-dev-key:${config.SESSION_SECRET}`).digest();
  } else {
    throw new Error('ENCRYPTION_KEY is required');
  }
  return {
    encrypt(plain, aad) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(Buffer.from(aad));
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]);
    },
    decrypt(input, aad) {
      const blob = Buffer.from(input); // drivers return bytea as Buffer or plain Uint8Array
      if (blob.length < 30 || blob[0] !== VERSION) throw new Error('unreadable credential');
      const d = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(blob.subarray(13, 29));
      try { return Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8'); }
      catch { throw new Error('unreadable credential'); } // wrong key, wrong owner, or tampered
    },
  };
}
