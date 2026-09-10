import { routeResponse, saveFrameCorrections } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ jobId: string; frameNumber: string }>;
};

export async function PUT(request: Request, { params }: Context) {
  const { jobId, frameNumber } = await params;
  return routeResponse(async () =>
    saveFrameCorrections(jobId, frameNumber, await request.json()),
  );
}

