import { routeResponse, saveBatchCorrections } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return routeResponse(async () =>
    saveBatchCorrections(jobId, await request.json()),
  );
}

