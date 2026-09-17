import { getPreviewImage, routeResponse } from "@/server/dashboard-api.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return routeResponse(async () => {
    const preview = await getPreviewImage(jobId);
    if (preview.redirectUrl) return Response.redirect(preview.redirectUrl, 307);
    return new Response(preview.data, {
      headers: {
        "Cache-Control": "private, max-age=300",
        "Content-Type": "image/jpeg",
      },
    });
  });
}
