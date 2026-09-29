import { demoFixturesEnabled } from "@/lib/demo-fixtures.server";
import NotificationsPageClient from "./NotificationsPageClient";

export default function NotificationsPage() {
  return <NotificationsPageClient demoMode={demoFixturesEnabled()} />;
}
