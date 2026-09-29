import { AncillaryPage } from "@/components/ancillary/AncillaryPage";
import styles from "./LegalPage.module.css";

export function LegalPage({
  title,
  children,
  viewer = null,
}: Readonly<{ title: string; children: React.ReactNode; viewer?: { displayName: string } | null }>) {
  return (
    <AncillaryPage title={title} viewer={viewer} narrow>
      <div className={styles.prose}>{children}</div>
    </AncillaryPage>
  );
}
