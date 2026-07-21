import { ArrowUUpLeft } from "@phosphor-icons/react";
import { translate as t } from "@matchday/ui";

type UndoDialogProps = { disabled: boolean; onUndo: () => void };

// The Phase 0 prototype intentionally keeps undo as a one-tap append-only reversal.
export function UndoDialog({ disabled, onUndo }: UndoDialogProps) {
  return (
    <button type="button" onClick={onUndo} disabled={disabled}>
      <ArrowUUpLeft size={28} aria-hidden="true" />
      {t("prototype.6f1b76f5352a")}
    </button>
  );
}
