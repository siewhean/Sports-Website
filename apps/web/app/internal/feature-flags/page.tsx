import { FeatureFlagsAdmin } from "@/components/phase3/FeatureFlagsAdmin";
import { getFeatureFlagsAdminDocument } from "@/lib/phase3-feature-flags-admin.server";

export default async function FeatureFlagsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ flag?: string; state?: string }>;
}) {
  const query = await searchParams;
  const document = await getFeatureFlagsAdminDocument(query.flag, query.state);
  return <FeatureFlagsAdmin document={document} />;
}
