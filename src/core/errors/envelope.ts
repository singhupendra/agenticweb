/** Success envelope shared by REST (body) and MCP (structuredContent). Failures are ProblemDetails. */
import { z } from "zod";

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}
export interface Envelope<T> {
  data: T;
  meta: { requestId: string } & Partial<PageMeta>;
}

export const envelopeSchema = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    meta: z.object({
      requestId: z.string(),
      page: z.number().int().optional(),
      pageSize: z.number().int().optional(),
      total: z.number().int().optional(),
    }),
  });

/** A capability returning this shape gets pagination meta lifted into the envelope. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), page: z.number().int(), pageSize: z.number().int(), total: z.number().int() });

export function toEnvelope(result: unknown, requestId: string): Envelope<unknown> {
  if (isPaginated(result)) {
    const { items, page, pageSize, total } = result;
    return { data: items, meta: { requestId, page, pageSize, total } };
  }
  return { data: result, meta: { requestId } };
}

function isPaginated(v: unknown): v is Paginated<unknown> {
  return (
    typeof v === "object" && v !== null && Array.isArray((v as Paginated<unknown>).items) &&
    typeof (v as Paginated<unknown>).page === "number" && typeof (v as Paginated<unknown>).total === "number"
  );
}
