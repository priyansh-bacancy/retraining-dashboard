import { getPreviewUrl, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return routeResponse(async () => Response.redirect(await getPreviewUrl(jobId), 307));
}

