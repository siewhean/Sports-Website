import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import styles from "./PlayLayout.module.css";

export default function PlayLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={styles.page}>
      <SiteHeader />
      <div className={styles.content}>{children}</div>
      <SiteFooter />
    </div>
  );
}
