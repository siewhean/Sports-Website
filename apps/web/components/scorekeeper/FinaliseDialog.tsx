import { translate as t } from "@matchday/ui";
import type { ScorekeeperTeam, SyncState } from "./types";
import styles from "../ScorekeeperPrototype.module.css";
import { cssModuleClasses as cx } from "../prototype/cssModuleClasses";

type FinaliseDialogProps = {
  open: boolean;
  scores: Record<ScorekeeperTeam, number>;
  syncState: SyncState;
  onCancel: () => void;
  onConfirm: () => void;
};

export function FinaliseDialog({ open, scores, syncState, onCancel, onConfirm }: FinaliseDialogProps) {
  if (!open) return null;

  return (
    <section className={cx(styles, "scorekeeper-final-review")} role="alertdialog" aria-labelledby="final-review-title">
      <div>
        <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.5529118b0637")}</p>
        <h2 id="final-review-title">
          {t("prototype.c280da3246a0")} {scores.blue}–{scores.gold}?
        </h2>
        <p>{syncState === "synced" ? t("prototype.3c0e8859e53d") : t("prototype.82a7737eb3ac")}</p>
      </div>
      <div className={cx(styles, "scorekeeper-review-actions")}>
        <button type="button" className={cx(styles, "scorekeeper-secondary-button")} onClick={onCancel}>
          {t("prototype.0cfdc30efedd")}
        </button>
        <button type="button" className={cx(styles, "scorekeeper-finalise-button")} onClick={onConfirm}>
          {t("prototype.0004ca08267c")}
        </button>
      </div>
    </section>
  );
}
