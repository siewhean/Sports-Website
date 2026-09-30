"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { opaqueId } from "@matchday/ui";
import { phase4OfficialsCopy, type OfficialView } from "@/lib/phase4-officials";
import styles from "./OfficialsRosterView.module.css";

type InvalidField = "name" | "default_role" | null;

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
  const [invalidField, setInvalidField] = useState<InvalidField>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const roleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (serverError) {
      nameInputRef.current?.focus();
    }
  }, [serverError]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setClientError(null);
    setInvalidField(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setInvalidField(opaqueId("name") as "name");
      setClientError(phase4OfficialsCopy.nameRequired);
      nameInputRef.current?.focus();
      return;
    }

    if (trimmedName.length > 80) {
      setInvalidField(opaqueId("name") as "name");
      setClientError(phase4OfficialsCopy.nameTooLong);
      nameInputRef.current?.focus();
      return;
    }

    const trimmedRole = defaultRole.trim();
    if (trimmedRole.length > 40) {
      setInvalidField(opaqueId("default_role") as "default_role");
      setClientError(phase4OfficialsCopy.roleTooLong);
      roleInputRef.current?.focus();
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
  const isNameInvalid =
    invalidField === opaqueId("name") || (Boolean(serverError) && invalidField !== opaqueId("default_role"));
  const isRoleInvalid = invalidField === opaqueId("default_role");

  return (
    <section className={styles.panel} aria-labelledby="official-form-heading">
      <div className={styles.detailsHeader}>
        <h3 id="official-form-heading">
          {mode === opaqueId("create") ? phase4OfficialsCopy.createTitle : phase4OfficialsCopy.editTitle}
        </h3>
      </div>

      {displayError ? (
        <div id="official-form-error" className={`${styles.errorAlert} ${styles.formAlert}`} role="alert">
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
              if (invalidField === opaqueId("name")) setInvalidField(null);
            }}
            placeholder={phase4OfficialsCopy.namePlaceholder}
            disabled={busy}
            aria-invalid={isNameInvalid}
            aria-describedby={displayError && isNameInvalid ? "official-form-error" : undefined}
            required
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="official-role" className={styles.label}>
            {phase4OfficialsCopy.roleLabel}
          </label>
          <input
            id="official-role"
            ref={roleInputRef}
            type="text"
            className={styles.input}
            value={defaultRole}
            onChange={(e) => {
              setDefaultRole(e.target.value);
              if (clientError) setClientError(null);
              if (invalidField === opaqueId("default_role")) setInvalidField(null);
            }}
            placeholder={phase4OfficialsCopy.rolePlaceholder}
            disabled={busy}
            aria-invalid={isRoleInvalid}
            aria-describedby={displayError && isRoleInvalid ? "official-form-error" : undefined}
          />
        </div>

        <div className={styles.formActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={busy}>
            {phase4OfficialsCopy.cancel}
          </button>
          <button type="submit" className={styles.primaryButton} disabled={busy}>
            {mode === opaqueId("create")
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
