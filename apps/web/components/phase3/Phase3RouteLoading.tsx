import styles from "./Phase3RouteLoading.module.css";

export function Phase3RouteLoading({ label, variant }: { label: string; variant: "settings" | "admin" }) {
  if (variant === "admin") {
    return (
      <main className={styles.loading} aria-busy="true" aria-label={label}>
        <header className={styles.topbar} />
        <div className={styles.adminBody}>
          <span className={styles.heading} />
          <span className={styles.rail} />
          <span className={styles.tabRow} />
          <div className={styles.fields}>
            {Array.from({ length: 6 }, (_, index) => (
              <span className={styles.field} key={index} />
            ))}
          </div>
          <span className={styles.rail} />
        </div>
      </main>
    );
  }

  return (
    <main className={styles.loading} aria-busy="true" aria-label={label}>
      <header className={styles.topbar} />
      <div className={styles.organiserBody}>
        <aside className={styles.nav} aria-hidden="true" />
        <div className={styles.workSurface}>
          <span className={styles.heading} />
          <span className={styles.context} />
          <div className={styles.settingsGrid}>
            <div className={styles.fields}>
              {Array.from({ length: 6 }, (_, index) => (
                <span className={styles.field} key={index} />
              ))}
            </div>
            <span className={styles.rail} />
          </div>
        </div>
      </div>
    </main>
  );
}
