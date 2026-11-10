import { getOidcHandlers } from "@/core/auth";
export const dynamic = "force-dynamic";
export const GET = async (request: Request) => (await getOidcHandlers()).callback(request);
