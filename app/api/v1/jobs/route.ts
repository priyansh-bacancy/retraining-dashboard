import { getJobs, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  return routeResponse(() => getJobs(query));
}

