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

export const ListServicesInput = z.strictObject({ orgSlug: slugSchema, ...pageInputShape });
export type ListServicesInput = z.infer<typeof ListServicesInput>;

export const GetServiceInput = z.strictObject({ orgSlug: slugSchema, serviceSlug: slugSchema });
export type GetServiceInput = z.infer<typeof GetServiceInput>;
