import { getFrameImage, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ jobId: string; frameNumber: string }>;
};

export async function GET(_request: Request, { params }: Context) {
  const { jobId, frameNumber } = await params;
  return routeResponse(async () => {
    const image = await getFrameImage(jobId, frameNumber);
    if (image.redirectUrl) return Response.redirect(image.redirectUrl, 307);
    return new Response(image.data, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": "image/jpeg",
      },
    });
  });
}

