import { publicSnapshotResponse } from "@/lib/public-snapshot.server";

// The response carries its own CDN Cache-Control; never let Next prerender or Data-Cache this handler.
export const dynamic = "force-dynamic";

/** Public competition view model + ETag for live updates. See lib/public-snapshot.ts for the client helper. */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  return publicSnapshotResponse(slug);
}
