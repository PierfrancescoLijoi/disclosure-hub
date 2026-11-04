/** Errors the HTTP layer maps to status codes; everything else is a 500. */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const unauthorized = (message = 'Unknown or missing user') => new DomainError(401, 'UNAUTHORIZED', message);
export const forbidden = (code: string, message: string) => new DomainError(403, code, message);
export const notFound = (what: string) => new DomainError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) =>
  new DomainError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new DomainError(422, code, message, details);
export const badRequest = (code: string, message: string) => new DomainError(400, code, message);
