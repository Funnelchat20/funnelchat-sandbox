import type { FieldErrors } from '../openapi/validate.js';
import { summarize } from '../openapi/validate.js';

/** An error answer of the API: `{error, message}` plus optional extra keys, with optional headers. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  body(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.extra };
  }
}

/** `401` of the gate (platform-gate `UnauthenticatedResponse`). */
export const unauthenticated = () =>
  new ApiError(401, 'unauthenticated', 'Falta la API key o no es válida.', {}, { 'WWW-Authenticate': 'Bearer' });

/** `404` of the edge for a route that no domain serves (api-edge `route_not_found`). */
export const routeNotFound = () => new ApiError(404, 'route_not_found', 'La ruta no existe en la API.');

export const notFound = (message = 'No encontramos lo que pediste en esta cuenta.') => new ApiError(404, 'not_found', message);

export const methodNotAllowed = (method: string, allowed: string[]) =>
  new ApiError(405, 'method_not_allowed', `El método ${method} no está disponible para esta ruta. Usá ${allowed.join(', ')}.`, {}, { Allow: allowed.join(', ') });

/** `422` of a validation: Laravel's `{message, errors}`, inside the `{error, message}` body of the sandbox. */
export const validationFailed = (errors: FieldErrors) => new ApiError(422, 'validation_failed', summarize(errors), { errors });

export const fieldError = (field: string, message: string) => validationFailed({ [field]: [message] });
