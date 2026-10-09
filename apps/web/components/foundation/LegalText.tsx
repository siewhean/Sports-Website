import styles from "./LegalPage.module.css";

const placeholderPattern = /(\[[A-Z][A-Z0-9 /,.-]*\])/;

/**
 * Renders legal copy and visibly highlights unfilled launch placeholders such as [DPO EMAIL], so they
 * cannot ship unnoticed. See docs/operations/LAUNCH_CHECKLIST.md.
 */
export function LegalText({ children }: Readonly<{ children: string }>) {
  return (
    <>
      {children.split(placeholderPattern).map((part, index) =>
        placeholderPattern.test(part) ? (
          <mark key={`${part}-${index}`} className={styles.placeholder} data-legal-placeholder="true">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
