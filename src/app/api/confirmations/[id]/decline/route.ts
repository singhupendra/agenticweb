import { declineConfirmation } from "@/api/confirmations";
export const dynamic = "force-dynamic";
export const POST = (request: Request, ctx: { params: Promise<{ id: string }> }) => declineConfirmation(request, ctx);
