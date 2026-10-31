export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) { super(message); }
}
export const badRequest = (m: string, code = 'bad_request') => new HttpError(400, code, m);
export const unauthorized = (m = 'Authentication required') => new HttpError(401, 'unauthorized', m);
export const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
export const conflict = (m: string, code = 'conflict') => new HttpError(409, code, m);
