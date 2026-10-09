"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { interpolate, messages } from "@matchday/ui";
import { accountUiMachine, type AccountDeletionState } from "@/lib/account-ui";
import { gateCC4Http } from "@/lib/gate-c-c4-http";
import { AncillaryPage } from "@/components/ancillary/AncillaryPage";
import styles from "./AccountPage.module.css";

export default function AccountPageClient({ displayName }: Readonly<{ displayName: string }>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<AccountDeletionState>(accountUiMachine.idle);
  const [error, setError] = useState<string | null>(null);
  const phrase = messages.account.confirmationPhrase;

  const closeDialog = () => {
    dialogRef.current?.close();
    setConfirmation("");
    setError(null);
  };

  const deleteAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    if (confirmation.trim() !== phrase) return;
    setState(accountUiMachine.deleting);
    setError(null);
    try {
      const response = await fetch("/api/account/deletion", {
        method: gateCC4Http.methodPost,
        headers: { "content-type": gateCC4Http.jsonContentType },
        body: JSON.stringify({ confirmation: confirmation.trim() }),
      });
      if (response.ok) {
        dialogRef.current?.close();
        setState(accountUiMachine.deleted);
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      const message = payload?.error?.message;
      // The API explains blocked deletions (sole owner of a live organisation); surface that text verbatim.
      setError(response.status === 409 && typeof message === "string" ? message : messages.account.deleteFailed);
    } catch {
      setError(messages.account.deleteFailed);
    }
    setState(accountUiMachine.idle);
  };

  if (state === accountUiMachine.deleted) {
    return (
      <AncillaryPage title={messages.account.deletedTitle} narrow>
        <div className={styles.workspace}>
          <section className={styles.panel} role="status">
            <p>{messages.account.deletedBody}</p>
            <div className={styles.actions}>
              <Link className={styles.primaryButton} href="/" prefetch={false}>
                {messages.account.deletedAction}
              </Link>
            </div>
          </section>
        </div>
      </AncillaryPage>
    );
  }

  return (
    <AncillaryPage title={messages.account.title} intro={messages.account.intro} viewer={{ displayName }} narrow>
      <div className={styles.workspace}>
        <p>{interpolate(messages.account.signedInAs, { name: displayName })}</p>

        <section className={styles.panel} aria-labelledby="account-export-heading">
          <h2 id="account-export-heading">{messages.account.exportHeading}</h2>
          <p>{messages.account.exportBody}</p>
          <div className={styles.actions}>
            <a className={styles.primaryButton} href="/api/account/data-export" download>
              {messages.account.exportAction}
            </a>
            <Link className={styles.secondaryButton} href="/privacy">
              {messages.account.privacyLink}
            </Link>
          </div>
        </section>

        <section className={`${styles.panel} ${styles.danger}`} aria-labelledby="account-delete-heading">
          <h2 id="account-delete-heading">{messages.account.deleteHeading}</h2>
          <p>{messages.account.deleteBody}</p>
          <h3>{messages.account.consequencesHeading}</h3>
          <ul>
            {messages.account.consequences.map((consequence) => (
              <li key={consequence}>{consequence}</li>
            ))}
          </ul>
          <div className={styles.actions}>
            <button type="button" className={styles.dangerButton} onClick={() => dialogRef.current?.showModal()}>
              {messages.account.deleteAction}
            </button>
          </div>
        </section>

        <dialog
          ref={dialogRef}
          className={styles.dialog}
          aria-labelledby="account-delete-dialog-title"
          onClose={closeDialog}
        >
          <form className={styles.dialogBody} onSubmit={deleteAccount}>
            <h2 id="account-delete-dialog-title">{messages.account.dialogTitle}</h2>
            <p>{messages.account.dialogIntro}</p>
            <label className={styles.field}>
              <span>{interpolate(messages.account.typePrompt, { phrase })}</span>
              <input
                className={styles.input}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-label={messages.account.confirmationLabel}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "account-delete-error" : undefined}
              />
            </label>
            {error ? (
              <p id="account-delete-error" className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button type="button" className={styles.secondaryButton} onClick={closeDialog}>
                {messages.account.cancel}
              </button>
              <button
                type="submit"
                className={styles.dangerButton}
                disabled={confirmation.trim() !== phrase || state === accountUiMachine.deleting}
                aria-busy={state === accountUiMachine.deleting}
              >
                {state === accountUiMachine.deleting ? messages.account.deleting : messages.account.confirmDelete}
              </button>
            </div>
          </form>
        </dialog>
      </div>
    </AncillaryPage>
  );
}
