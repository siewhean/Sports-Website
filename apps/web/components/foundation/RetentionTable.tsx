import { legalMessages, retentionSchedule } from "@matchday/ui";
import styles from "./LegalPage.module.css";

export function RetentionTable() {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{legalMessages.privacy.retentionDataColumn}</th>
            <th>{legalMessages.privacy.retentionPeriodColumn}</th>
          </tr>
        </thead>
        <tbody>
          {retentionSchedule.map((row) => (
            <tr key={row.data}>
              <th>{row.data}</th>
              <td>{row.period}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
