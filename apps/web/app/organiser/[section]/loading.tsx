import { OrganiserWorkspace } from "@/components/phase2/OrganiserWorkspace";
import { phase2Machine } from "@/lib/phase2";

export default function Loading() {
  return <OrganiserWorkspace state={phase2Machine.loading} />;
}
