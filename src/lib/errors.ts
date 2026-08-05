/**
 * FieldFlow typed errors.
 *
 * Server actions, route handlers and repositories throw these instead of bare
 * Errors so callers can map them to HTTP responses / client messages without
 * string sniffing. `isAppError` guards instanceof checks across copies.
 */

export class AppError extends Error {
  /** Machine-readable code, e.g. "UNAUTHORIZED", "CUSTOMER_NOT_FOUND". */
  readonly code: string;
  /** HTTP status this error maps to. */
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(
    message: string,
    options?: { code?: string; statusCode?: number; details?: unknown; cause?: unknown },
  ) {
    super(message);
    this.name = new.target.name;
    this.code = options?.code ?? "APP_ERROR";
    this.statusCode = options?.statusCode ?? 500;
    this.details = options?.details;
    if (options?.cause !== undefined) {
      // ES2022 Error cause (lib "esnext" in tsconfig).
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 401 — not signed in, or session has no provisioned org/user. */
export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.", details?: unknown) {
    super(message, { code: "UNAUTHORIZED", statusCode: 401, details });
  }
}

/** 403 — signed in, but not allowed to do this in this org. */
export class ForbiddenError extends AppError {
  constructor(message = "You are not allowed to perform this action.", details?: unknown) {
    super(message, { code: "FORBIDDEN", statusCode: 403, details });
  }
}

/** 404 — resource not found (within the tenant scope). */
export class NotFoundError extends AppError {
  constructor(message = "Resource not found.", details?: unknown) {
    super(message, { code: "NOT_FOUND", statusCode: 404, details });
  }
}

/** 400 — input failed Zod validation. */
export class ValidationError extends AppError {
  readonly issues?: { path: string; message: string }[];

  constructor(message = "Invalid input.", issues?: { path: string; message: string }[]) {
    super(message, { code: "VALIDATION", statusCode: 400, details: issues });
    this.issues = issues;
  }
}

/** 409 — uniqueness/state conflict (e.g. duplicate slug, invalid status transition). */
export class ConflictError extends AppError {
  constructor(message = "The request conflicts with the current state.", details?: unknown) {
    super(message, { code: "CONFLICT", statusCode: 409, details });
  }
}

/** 501 — deliberate stub for a later slice. */
export class NotImplementedError extends AppError {
  constructor(message = "Not implemented yet.") {
    super(message, { code: "NOT_IMPLEMENTED", statusCode: 501 });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Shape returned by server actions to the client: { ok, data? } | { ok, error }. */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

/** Maps any thrown value to an ActionResult error — use at the top of every server action. */
export function actionError(err: unknown): { ok: false; error: { code: string; message: string } } {
  if (isAppError(err)) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  if (err instanceof Error) {
    return { ok: false, error: { code: "INTERNAL", message: err.message } };
  }
  return { ok: false, error: { code: "INTERNAL", message: "An unexpected error occurred." } };
}
