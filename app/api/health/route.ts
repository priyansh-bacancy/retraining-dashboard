import { getHealth, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return routeResponse(() => getHealth());
}

