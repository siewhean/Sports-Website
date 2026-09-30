"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { opaqueId } from "@matchday/ui";
import { phase4OfficialsCopy, type OfficialView } from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

export function OfficialForm({
  mode,
  initialOfficial,
  onSubmit,
  onCancel,
  busy,
  serverError,
}: {
  mode: "create" | "edit";
  initialOfficial?: OfficialView | null;
  onSubmit: (data: { name: string; defaultRole?: string | null }) => void;
  onCancel: () => void;
  busy: boolean;
  serverError?: string | null;
}) {
  const [name, setName] = useState(initialOfficial?.name ?? "");
  const [defaultRole, setDefaultRole] = useState(initialOfficial?.defaultRole ?? "");
  const [clientError, setClientError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setClientError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setClientError(phase4OfficialsCopy.nameRequired);
      nameInputRef.current?.focus();
      return;
    }

    if (trimmedName.length > 80) {
      setClientError(phase4OfficialsCopy.nameTooLong);
      nameInputRef.current?.focus();
      return;
    }

    const trimmedRole = defaultRole.trim();
    if (trimmedRole.length > 40) {
      setClientError(phase4OfficialsCopy.roleTooLong);
      return;
    }

    if (mode === opaqueId("edit") && initialOfficial) {
      const currentRole = initialOfficial.defaultRole ?? "";
      if (trimmedName === initialOfficial.name && trimmedRole === currentRole) {
        onCancel();
        return;
      }
    }

    onSubmit({
      name: trimmedName,
      defaultRole: trimmedRole.length > 0 ? trimmedRole : null,
    });
  };

  const displayError = clientError || serverError;

  return (
    <section className={styles.panel} aria-labelledby="official-form-heading">
      <div className={styles.detailsHeader}>
        <h3 id="official-form-heading">
          {mode === opaqueId("create") ? phase4OfficialsCopy.createTitle : phase4OfficialsCopy.editTitle}
        </h3>
      </div>

      {displayError ? (
        <div className={`${styles.errorAlert} ${styles.formAlert}`} role="alert">
          {displayError}
        </div>
      ) : null}

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label htmlFor="official-name" className={styles.label}>
            {phase4OfficialsCopy.nameLabel}
          </label>
          <input
            id="official-name"
            ref={nameInputRef}
            type="text"
            className={styles.input}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (clientError) setClientError(null);
            }}
            placeholder={phase4OfficialsCopy.namePlaceholder}
            maxLength={80}
            disabled={busy}
            aria-invalid={Boolean(displayError)}
            required
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="official-role" className={styles.label}>
            {phase4OfficialsCopy.roleLabel}
          </label>
          <input
            id="official-role"
            type="text"
            className={styles.input}
            value={defaultRole}
            onChange={(e) => {
              setDefaultRole(e.target.value);
              if (clientError) setClientError(null);
            }}
            placeholder={phase4OfficialsCopy.rolePlaceholder}
            maxLength={40}
            disabled={busy}
          />
        </div>

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
            {phase4OfficialsCopy.cancel}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {mode === "create"
              ? busy
                ? phase4OfficialsCopy.creating
                : phase4OfficialsCopy.addOfficial
              : busy
                ? phase4OfficialsCopy.saving
                : phase4OfficialsCopy.save}
          </button>
        </div>
      </form>
    </section>
  );
}
