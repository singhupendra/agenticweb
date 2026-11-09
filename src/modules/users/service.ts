import type { UserProfile } from "./schemas";

/** CONTRACT ONLY. Agents with only `profile:read` receive the same shape; email requires that scope. */
export interface UserService {
  getProfile(userId: string): Promise<UserProfile>;
}
