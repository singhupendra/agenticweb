/**
 * Delegation grants: the server-side record of what a user consented to for an agent client.
 * When a GrantStore is configured it is AUTHORITATIVE: token scopes are intersected with the grant (narrowing only),
 * and revocation takes effect immediately even though access tokens are short-lived.
 */
import type { Scope } from "./actor";

export interface Grant {
  grantId: string;
  userId: string;
  clientId: string;
  scopes: readonly Scope[];
  revokedAt?: string | null;
}

export interface GrantStore {
  get(grantId: string): Promise<Grant | null>;
}

export class InMemoryGrantStore implements GrantStore {
  private readonly grants = new Map<string, Grant>();
  constructor(grants: Grant[] = []) {
    for (const g of grants) this.grants.set(g.grantId, g);
  }
  put(g: Grant): void {
    this.grants.set(g.grantId, g);
  }
  revoke(grantId: string, at = new Date()): void {
    const g = this.grants.get(grantId);
    if (g) this.grants.set(grantId, { ...g, revokedAt: at.toISOString() });
  }
  async get(grantId: string): Promise<Grant | null> {
    return this.grants.get(grantId) ?? null;
  }
}
