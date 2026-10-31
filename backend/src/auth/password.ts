import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 2 ** 14, R = 8, P = 1, KEYLEN = 32;

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    const opts: ScryptOptions = { N: n, r, p, maxmem: 128 * n * r * 2 };
    scrypt(password.normalize('NFKC'), salt, KEYLEN, opts, (e, k) => (e ? reject(e) : resolve(k)));
  });

/** scrypt$N$r$p$salt$hash (all base64url): self-describing, so the cost can be raised later without breaking old hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await derive(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p)).catch(() => null);
  return got !== null && got.length === expected.length && timingSafeEqual(got, expected);
}
