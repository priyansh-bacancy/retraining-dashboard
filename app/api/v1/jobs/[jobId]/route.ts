import { getJobDetail, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  return routeResponse(() => getJobDetail(jobId, query));
}

