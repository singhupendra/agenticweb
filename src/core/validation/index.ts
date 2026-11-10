/** Validation helpers. Schemas live with their module (schemas.ts in each src/modules folder). */
import { z } from "zod";
import { validationError, type FieldIssue } from "../errors";

export const MAX_PAGE_SIZE = 50;

export const pageInputShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
};

export const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase slug");
export const idSchema = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });

export function toIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code }));
}

/** Parse untrusted input with a module schema; throws a problem-detail ValidationError. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) throw validationError(toIssues(r.error));
  return r.data;
}
