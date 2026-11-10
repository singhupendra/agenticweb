/** CONTRACT ONLY (Phase 3 implements). */
import { z } from "zod";
import { idSchema } from "@/core/validation";

export const UserRoleSchema = z.enum(["customer", "admin"]);
export const UserProfileSchema = z.object({ id: idSchema, name: z.string(), email: z.string().email(), role: UserRoleSchema });
export type UserProfile = z.infer<typeof UserProfileSchema>;
