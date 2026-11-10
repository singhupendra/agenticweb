/**
 * Server-side data access for pages. Thin: every call goes through the capability executor
 * (same validation, authorization, idempotency and audit as REST/MCP). No business rules here.
 */
import { headers } from "next/headers";
import { cache } from "react";
import { defaultResolver } from "@/api/rest";
import { ANONYMOUS, type Actor } from "@/core/auth";
import { getEnv } from "@/core/env";
import { AppError } from "@/core/errors";
import { getRuntime } from "@/runtime";
import type { Booking, Slot } from "@/modules/bookings/schemas";
import type { Organization } from "@/modules/organization/schemas";
import type { Service } from "@/modules/services/schemas";

export const orgSlug = () => getEnv().DEFAULT_ORG_SLUG;

/** The visitor's actor, via the same ActorResolver REST uses (dev header today; sessions in Phase 3). */
export async function currentActor(): Promise<Actor> {
  const h = await headers();
  return defaultResolver().resolve(new Request(getEnv().APP_URL, { headers: h }));
}

const invoke = async <T>(name: string, actor: Actor, input: unknown): Promise<T> =>
  (await getRuntime().executor.invoke(name, actor, input)).data as T;

export const getOrganization = cache(async (): Promise<Organization> => {
  return invoke("organization.get", ANONYMOUS, { orgSlug: orgSlug() });
});

export const listServices = cache(async (): Promise<Service[]> => {
  return invoke("services.list", ANONYMOUS, { orgSlug: orgSlug() });
});

export async function getService(serviceSlug: string): Promise<Service> {
  return invoke("services.get", ANONYMOUS, { orgSlug: orgSlug(), serviceSlug });
}

export async function listSlots(serviceSlug: string, pageSize = 12): Promise<Slot[]> {
  return invoke("slots.list", ANONYMOUS, { orgSlug: orgSlug(), serviceSlug, pageSize });
}

export async function getBooking(actor: Actor, bookingId: string): Promise<Booking> {
  return invoke("bookings.get", actor, { orgSlug: orgSlug(), bookingId });
}

export const MY_BOOKINGS_PAGE_SIZE = 10;
export async function listMyBookings(actor: Actor, page: number): Promise<{ items: Booking[]; total: number; page: number; pageSize: number }> {
  const { data, meta } = await getRuntime().executor.invoke("bookings.list", actor, { orgSlug: orgSlug(), page, pageSize: MY_BOOKINGS_PAGE_SIZE });
  return { items: data as Booking[], total: meta.total ?? 0, page: meta.page ?? page, pageSize: meta.pageSize ?? MY_BOOKINGS_PAGE_SIZE };
}

export const isNotFound = (e: unknown) => e instanceof AppError && (e.code === "not_found" || e.code === "validation_failed");
