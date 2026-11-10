import { restHandler } from "@/api/rest";
export const dynamic = "force-dynamic";
export const GET = restHandler("bookings.list");
export const POST = restHandler("bookings.create");
