import { z } from "zod";
import { slugSchema, idSchema } from "@/core/validation";

export const OrganizationSchema = z.object({
  id: idSchema,
  slug: slugSchema,
  name: z.string(),
  timezone: z.string(),
});
export type Organization = z.infer<typeof OrganizationSchema>;

export const GetOrganizationInput = z.strictObject({ orgSlug: slugSchema });
export type GetOrganizationInput = z.infer<typeof GetOrganizationInput>;
