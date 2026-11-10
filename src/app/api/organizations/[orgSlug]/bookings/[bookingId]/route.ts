import { restHandler } from "@/api/rest";
export const dynamic = "force-dynamic";
export const GET = restHandler("bookings.get");
export const PATCH = restHandler("bookings.update");
/** REST spelling of cancel (`bookings.cancel` alias); `POST …/cancel` remains available. */
export const DELETE = restHandler("bookings.cancel");
