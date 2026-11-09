/**
 * Error model (RFC 9457 problem details).
 * Every failure in every channel is an AppError → ProblemDetails. Never throw bare Errors for expected failures.
 */
import { z } from "zod";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";
export const PROBLEM_TYPE_BASE = "https://agenticweb.dev/problems/";

/** Stable machine-readable codes. Adding a code is allowed; renaming/removing is a breaking change. */
export const ERROR_CODES = {
  validation_failed: { status: 400, title: "Request validation failed" },
  unauthenticated: { status: 401, title: "Authentication required" },
  forbidden: { status: 403, title: "Forbidden" },
  not_found: { status: 404, title: "Resource not found" },
  conflict: { status: 409, title: "Conflict" },
  idempotency_key_required: { status: 400, title: "Idempotency-Key required" },
  idempotency_key_reuse: { status: 422, title: "Idempotency-Key reused with a different request" },
  rate_limited: { status: 429, title: "Too many requests" },
  not_ready: { status: 503, title: "Service not ready" },
  internal: { status: 500, title: "Internal server error" },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const FieldIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string().optional(),
});
export type FieldIssue = z.infer<typeof FieldIssueSchema>;

export const ProblemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string().optional(),
  errors: z.array(FieldIssueSchema).optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly errors?: FieldIssue[];
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    detail?: string,
    opts: { errors?: FieldIssue[]; cause?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(detail ?? ERROR_CODES[code].title, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.errors = opts.errors;
    this.headers = opts.headers;
  }
}

export const validationError = (issues: FieldIssue[], detail = "One or more fields are invalid.") =>
  new AppError("validation_failed", detail, { errors: issues });
export const unauthenticated = (detail = "Valid credentials are required.") => new AppError("unauthenticated", detail);
export const forbidden = (detail = "You are not allowed to perform this action.") => new AppError("forbidden", detail);
export const notFound = (what = "Resource") => new AppError("not_found", `${what} was not found.`);
export const conflict = (detail: string) => new AppError("conflict", detail);

export function toProblem(err: unknown, ctx: { requestId?: string; instance?: string } = {}): ProblemDetails {
  if (err instanceof AppError) {
    return {
      type: PROBLEM_TYPE_BASE + err.code,
      title: ERROR_CODES[err.code].title,
      status: err.status,
      // 500s never leak their message.
      detail: err.code === "internal" ? undefined : err.message,
      instance: ctx.instance,
      code: err.code,
      requestId: ctx.requestId,
      errors: err.errors,
    };
  }
  // Unknown errors: generic 500. The caller is responsible for logging the original.
  return {
    type: PROBLEM_TYPE_BASE + "internal",
    title: ERROR_CODES.internal.title,
    status: 500,
    code: "internal",
    instance: ctx.instance,
    requestId: ctx.requestId,
  };
}

export function problemResponse(err: unknown, ctx: { requestId?: string; instance?: string } = {}): Response {
  const problem = toProblem(err, ctx);
  const headers = new Headers({ "content-type": PROBLEM_CONTENT_TYPE, "cache-control": "no-store" });
  if (ctx.requestId) headers.set("x-request-id", ctx.requestId);
  if (err instanceof AppError && err.headers) for (const [k, v] of Object.entries(err.headers)) headers.set(k, v);
  return new Response(JSON.stringify(problem), { status: problem.status, headers });
}
