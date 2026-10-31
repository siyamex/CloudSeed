import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface OidcConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuers: string[];
}

export interface IdentityClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

export function googleOidc(clientId: string, clientSecret: string, redirectUri: string): OidcConfig {
  return {
    clientId, clientSecret, redirectUri,
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
  };
}

/** Scopes are limited to identity; no Drive/Gmail access is ever requested. */
export function buildAuthUrl(cfg: OidcConfig, p: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(cfg.authEndpoint);
  u.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();
  return u.toString();
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
function jwksFor(uri: string): JWTVerifyGetKey {
  let k = jwksCache.get(uri);
  if (!k) { k = createRemoteJWKSet(new URL(uri), { timeoutDuration: 5000 }); jwksCache.set(uri, k); }
  return k;
}

export class OidcError extends Error {}

/** Exchanges the authorization code (with PKCE verifier) and fully validates the ID token. */
export async function exchangeAndVerify(
  cfg: OidcConfig, code: string, codeVerifier: string, expectedNonce: string,
): Promise<IdentityClaims> {
  const res = await fetch(cfg.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new OidcError(`token endpoint returned ${res.status}`);
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) throw new OidcError('no id_token in response');

  let payload;
  try {
    ({ payload } = await jwtVerify(body.id_token, jwksFor(cfg.jwksUri), {
      issuer: cfg.issuers, audience: cfg.clientId, algorithms: ['RS256'], clockTolerance: 30,
    }));
  } catch (e) {
    throw new OidcError(`id_token rejected: ${(e as Error).message}`);
  }
  if (payload.nonce !== expectedNonce) throw new OidcError('nonce mismatch');
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new OidcError('missing sub/email claims');
  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
