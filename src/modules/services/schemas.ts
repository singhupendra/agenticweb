import { z } from "zod";
import { idSchema, pageInputShape, slugSchema } from "@/core/validation";

export const ServiceSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  description: z.string(),
  durationMinutes: z.number().int().positive(),
  /** Integer minor units (e.g. paise/cents). */
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
});
export type Service = z.infer<typeof ServiceSchema>;

export const SERVICE_SORTS = ["name", "-name", "priceMinor", "-priceMinor", "durationMinutes", "-durationMinutes"] as const;
export const ServiceSortSchema = z.enum(SERVICE_SORTS);
export type ServiceSort = z.infer<typeof ServiceSortSchema>;

export const ListServicesInput = z.strictObject({
  orgSlug: slugSchema,
  /** Case-insensitive substring match on the service name. */
  q: z.string().trim().min(1).max(80).optional(),
  /** Only services priced at or below this many minor units. */
  maxPriceMinor: z.coerce.number().int().min(0).optional(),
  sort: ServiceSortSchema.default("name"),
  ...pageInputShape,
});
export type ListServicesInput = z.infer<typeof ListServicesInput>;

export const GetServiceInput = z.strictObject({ orgSlug: slugSchema, serviceSlug: slugSchema });
export type GetServiceInput = z.infer<typeof GetServiceInput>;
