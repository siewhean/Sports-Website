import { SportDefaultsAdmin } from "@/components/phase3/SportDefaultsAdmin";
import { getSportDefaultsAdminDocument } from "@/lib/phase3-sport-settings.server";

export default async function SportDefaultsAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ sport?: string; version?: string; state?: string }>;
}) {
  const query = await searchParams;
  return <SportDefaultsAdmin document={await getSportDefaultsAdminDocument(query.sport, query.version, query.state)} />;
}
