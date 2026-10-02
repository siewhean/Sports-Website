import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";
import styles from "./AncillaryPage.module.css";

export function AncillaryPage({
  title,
  intro,
  children,
  viewer = null,
  narrow = false,
}: Readonly<{
  title: string;
  intro?: string;
  children: React.ReactNode;
  viewer?: { displayName: string } | null;
  narrow?: boolean;
}>) {
  return (
    <div className={styles.page}>
      <SiteHeader viewer={viewer} />
      <main className={`${styles.main} ${narrow ? styles.narrow : ""}`} id="main-content">
        <header className={styles.heading}>
          <h1>{title}</h1>
          {intro ? <p>{intro}</p> : null}
        </header>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
