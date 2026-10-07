"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKey, ShieldWarning, WarningCircle } from "@phosphor-icons/react";
import {
  featureFlagAdminCopy,
  featureFlagAdminMachine,
  type FeatureFlagAdminDocument,
  type FeatureFlagOverrideItem,
  type FeatureFlagScopeDto,
  type FeatureFlagSummary,
  type ScopeKind,
} from "@/lib/phase3-feature-flags-admin";
import styles from "./FeatureFlagsAdmin.module.css";

interface MutationConfirmDialogState {
  flagKey: string;
  scope: FeatureFlagScopeDto;
  oldValue: unknown;
  newValue: unknown;
  action: typeof featureFlagAdminMachine.actionPut | typeof featureFlagAdminMachine.actionDelete;
}

export function FeatureFlagsAdmin({ document }: { document: FeatureFlagAdminDocument }) {
  const router = useRouter();
  const [flags] = useState<readonly FeatureFlagSummary[]>(document.flags);
  const [selectedKey, setSelectedKey] = useState<string>(document.activeFlagKey ?? document.flags[0]?.key ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [targetScopeKind, setTargetScopeKind] = useState<ScopeKind>(featureFlagAdminMachine.globalKind);
  const [targetScopeId, setTargetScopeId] = useState("");
  const [overrideValue, setOverrideValue] = useState<string>(featureFlagAdminMachine.trueValue);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<MutationConfirmDialogState | null>(null);

  const selectedFlag = useMemo(
    () => flags.find((f) => f.key === selectedKey) ?? flags[0] ?? null,
    [flags, selectedKey],
  );

  const filteredFlags = useMemo(() => {
    if (!searchQuery.trim()) return flags;
    const q = searchQuery.toLowerCase();
    return flags.filter((f) => f.key.toLowerCase().includes(q) || f.description.toLowerCase().includes(q));
  }, [flags, searchQuery]);

  const currentScope: FeatureFlagScopeDto = useMemo(() => {
    if (targetScopeKind === featureFlagAdminMachine.globalKind) return { kind: featureFlagAdminMachine.globalKind };
    return { kind: targetScopeKind, id: targetScopeId.trim() };
  }, [targetScopeKind, targetScopeId]);

  // Find explicit override for current scope
  const explicitOverride: FeatureFlagOverrideItem | undefined = useMemo(() => {
    if (!selectedFlag) return undefined;
    return selectedFlag.overrides.find((o) => {
      if (o.scope.kind !== currentScope.kind) return false;
      if (currentScope.kind === featureFlagAdminMachine.globalKind) return true;
      return (o.scope as { id: string }).id === currentScope.id;
    });
  }, [selectedFlag, currentScope]);

  // Determine effective value & status badge
  const { effectiveValue, statusBadge } = useMemo(() => {
    if (!selectedFlag) {
      return { effectiveValue: false, statusBadge: featureFlagAdminCopy.statusRegistryDefault };
    }
    if (explicitOverride) {
      return {
        effectiveValue: explicitOverride.value,
        statusBadge: featureFlagAdminCopy.statusExplicitOverride,
      };
    }
    // Check if there is an inherited global override when looking at scoped entity
    if (currentScope.kind !== featureFlagAdminMachine.globalKind) {
      const globalOverride = selectedFlag.overrides.find((o) => o.scope.kind === featureFlagAdminMachine.globalKind);
      if (globalOverride) {
        return {
          effectiveValue: globalOverride.value,
          statusBadge: featureFlagAdminCopy.statusInherited,
        };
      }
    }
    return {
      effectiveValue: selectedFlag.defaultValue,
      statusBadge: featureFlagAdminCopy.statusRegistryDefault,
    };
  }, [selectedFlag, explicitOverride, currentScope]);

  if (
    document.state === featureFlagAdminMachine.permission ||
    document.state === featureFlagAdminMachine.revoked ||
    document.state === featureFlagAdminMachine.expired
  ) {
    return (
      <div className={styles["ff-admin"]}>
        <div className={styles["ff-admin__body"]}>
          <div className={`${styles["ff-card"]} ${styles["ff-state-card"]}`}>
            <LockKey size={48} color="#c53030" className={styles["ff-state-icon"]} />
            <h2>{featureFlagAdminCopy.permissionTitle}</h2>
            <p>{featureFlagAdminCopy.permissionBody}</p>
          </div>
        </div>
      </div>
    );
  }

  if (document.state === featureFlagAdminMachine.offline || document.state === featureFlagAdminMachine.error) {
    return (
      <div className={styles["ff-admin"]}>
        <div className={styles["ff-admin__body"]}>
          <div className={`${styles["ff-card"]} ${styles["ff-state-card"]}`}>
            <WarningCircle size={48} color="#c53030" className={styles["ff-state-icon"]} />
            <h2>
              {document.state === featureFlagAdminMachine.offline
                ? featureFlagAdminCopy.offlineTitle
                : featureFlagAdminCopy.errorTitle}
            </h2>
            <p>
              {document.state === featureFlagAdminMachine.offline
                ? featureFlagAdminCopy.offlineBody
                : featureFlagAdminCopy.errorBody}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const isScopeIdMissing = targetScopeKind !== featureFlagAdminMachine.globalKind && !targetScopeId.trim();
  const isReasonValid = reason.trim().length >= 3;

  function triggerSaveOverride() {
    if (!selectedFlag || isScopeIdMissing || !isReasonValid || busy) return;
    const parsedValue = overrideValue === featureFlagAdminMachine.trueValue;

    // Dangerous changes: maintenance.global or global-scope modifications
    const isDangerous =
      selectedFlag.key === "maintenance.global" || currentScope.kind === featureFlagAdminMachine.globalKind;
    if (isDangerous) {
      setConfirmDialog({
        flagKey: selectedFlag.key,
        scope: currentScope,
        oldValue: effectiveValue,
        newValue: parsedValue,
        action: featureFlagAdminMachine.actionPut,
      });
      return;
    }

    void executeSave(parsedValue);
  }

  function triggerDeleteOverride() {
    if (!selectedFlag || !explicitOverride || isScopeIdMissing || !isReasonValid || busy) return;

    // Dangerous if maintenance.global or global scope
    const isDangerous =
      selectedFlag.key === "maintenance.global" || currentScope.kind === featureFlagAdminMachine.globalKind;
    if (isDangerous) {
      setConfirmDialog({
        flagKey: selectedFlag.key,
        scope: currentScope,
        oldValue: explicitOverride.value,
        newValue: selectedFlag.defaultValue,
        action: featureFlagAdminMachine.actionDelete,
      });
      return;
    }

    void executeDelete();
  }

  async function executeSave(newValue: boolean) {
    if (!selectedFlag) return;
    setBusy(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/phase3/admin/feature-flags/${encodeURIComponent(selectedFlag.key)}/override`, {
        method: featureFlagAdminMachine.put,
        headers: { "content-type": featureFlagAdminMachine.applicationJson },
        body: JSON.stringify({
          scope: currentScope,
          value: newValue,
          reason: reason.trim(),
          ...(explicitOverride ? { expected_updated_at: explicitOverride.updatedAt } : {}),
        }),
      });

      const payload = await response.json().catch(() => null);

      if (response.status === 409) {
        setErrorMessage(featureFlagAdminCopy.conflictBody);
        router.refresh();
        return;
      }

      if (!response.ok) {
        setErrorMessage(payload?.error?.message ?? featureFlagAdminCopy.saveFailed);
        return;
      }

      setMessage(featureFlagAdminCopy.saveSuccess);
      setReason("");
      router.refresh();
    } catch {
      setErrorMessage(featureFlagAdminCopy.offlineBody);
    } finally {
      setBusy(false);
      setConfirmDialog(null);
    }
  }

  async function executeDelete() {
    if (!selectedFlag || !explicitOverride) return;
    setBusy(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch(`/api/phase3/admin/feature-flags/${encodeURIComponent(selectedFlag.key)}/override`, {
        method: featureFlagAdminMachine.delete,
        headers: { "content-type": featureFlagAdminMachine.applicationJson },
        body: JSON.stringify({
          scope: currentScope,
          reason: reason.trim(),
          expected_updated_at: explicitOverride.updatedAt,
        }),
      });

      const payload = await response.json().catch(() => null);

      if (response.status === 409) {
        setErrorMessage(featureFlagAdminCopy.conflictBody);
        router.refresh();
        return;
      }

      if (!response.ok) {
        setErrorMessage(payload?.error?.message ?? featureFlagAdminCopy.deleteFailed);
        return;
      }

      setMessage(featureFlagAdminCopy.deleteSuccess);
      setReason("");
      router.refresh();
    } catch {
      setErrorMessage(featureFlagAdminCopy.offlineBody);
    } finally {
      setBusy(false);
      setConfirmDialog(null);
    }
  }

  return (
    <div className={styles["ff-admin"]}>
      <header className={styles["ff-admin__header"]}>
        <Link href="/internal/sport-defaults" className={styles["ff-admin__wordmark"]}>
          <span>{featureFlagAdminCopy.brandMark}</span> {featureFlagAdminCopy.brandTitle}
        </Link>
        <div>{featureFlagAdminCopy.brandSubtitle}</div>
      </header>

      <main className={styles["ff-admin__body"]}>
        <div className={styles["ff-admin__intro"]}>
          <h1>{featureFlagAdminCopy.pageTitle}</h1>
          <p>{featureFlagAdminCopy.pageIntro}</p>
        </div>

        {message && <div className={styles["ff-banner-success"]}>{message}</div>}
        {errorMessage && <div className={styles["ff-banner-error"]}>{errorMessage}</div>}

        <div className={styles["ff-admin__layout"]}>
          <aside className={styles["ff-admin__sidebar"]}>
            <input
              type="search"
              className={styles["ff-search-input"]}
              placeholder={featureFlagAdminCopy.searchPlaceholder}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <ul className={styles["ff-flag-list"]}>
              {filteredFlags.map((flag) => {
                const isSelected = flag.key === selectedKey;
                const overrideSuffix =
                  flag.overrides.length === 1
                    ? featureFlagAdminCopy.overrideSuffixSingular
                    : featureFlagAdminCopy.overrideSuffixPlural;
                return (
                  <li key={flag.key}>
                    <button
                      type="button"
                      className={styles["ff-flag-item"]}
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => {
                        setSelectedKey(flag.key);
                        setMessage(null);
                        setErrorMessage(null);
                      }}
                    >
                      <span className={styles["ff-flag-item__key"]}>{flag.key}</span>
                      <span className={styles["ff-flag-item__meta"]}>
                        <span>
                          {featureFlagAdminCopy.defaultPrefix}
                          {String(flag.defaultValue)}
                        </span>
                        <span>
                          {flag.overrides.length}
                          {overrideSuffix}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className={styles["ff-admin__main"]}>
            {selectedFlag ? (
              <>
                <div className={styles["ff-card"]}>
                  <div className={styles["ff-card__header"]}>
                    <div>
                      <h2 className={styles["ff-card__title"]}>{selectedFlag.key}</h2>
                      <p className={styles["ff-card__desc"]}>{selectedFlag.description}</p>
                    </div>
                    <span className={`${styles["ff-badge"]} ${styles["ff-badge--default"]}`}>
                      {featureFlagAdminCopy.defaultPrefix}
                      {String(selectedFlag.defaultValue)}
                    </span>
                  </div>

                  <div className={styles["ff-form-grid"]}>
                    <div className={styles["ff-form-row"]}>
                      <div className={styles["ff-form-field"]}>
                        <label>{featureFlagAdminCopy.scopeLabel}</label>
                        <select
                          className={styles["ff-select"]}
                          value={targetScopeKind}
                          onChange={(e) => setTargetScopeKind(e.target.value as ScopeKind)}
                        >
                          <option value={featureFlagAdminMachine.globalKind}>{featureFlagAdminCopy.scopeGlobal}</option>
                          <option value={featureFlagAdminMachine.orgKind}>{featureFlagAdminCopy.scopeOrg}</option>
                          <option value={featureFlagAdminMachine.compKind}>{featureFlagAdminCopy.scopeComp}</option>
                          <option value={featureFlagAdminMachine.accountKind}>
                            {featureFlagAdminCopy.scopeAccount}
                          </option>
                        </select>
                      </div>

                      {targetScopeKind !== featureFlagAdminMachine.globalKind && (
                        <div className={styles["ff-form-field"]}>
                          <label>{featureFlagAdminCopy.scopeIdLabel}</label>
                          <input
                            type="text"
                            className={styles["ff-input"]}
                            placeholder={featureFlagAdminCopy.scopeIdPlaceholder}
                            value={targetScopeId}
                            onChange={(e) => setTargetScopeId(e.target.value)}
                          />
                        </div>
                      )}
                    </div>

                    <div className={styles["ff-effective-preview"]}>
                      <span>
                        <strong>{featureFlagAdminCopy.effectiveStateLabel}</strong>
                      </span>
                      <span className={styles["ff-effective-mono"]}>{String(effectiveValue)}</span>
                      <span
                        className={
                          `${styles["ff-badge"]} ` +
                          (statusBadge === featureFlagAdminCopy.statusExplicitOverride
                            ? styles["ff-badge--override"]
                            : statusBadge === featureFlagAdminCopy.statusInherited
                              ? styles["ff-badge--inherited"]
                              : styles["ff-badge--default"])
                        }
                      >
                        {statusBadge}
                      </span>
                    </div>

                    <div className={styles["ff-form-field"]}>
                      <label>{featureFlagAdminCopy.setOverrideValueLabel}</label>
                      <select
                        className={styles["ff-select"]}
                        value={overrideValue}
                        onChange={(e) => setOverrideValue(e.target.value)}
                      >
                        <option value={featureFlagAdminMachine.trueValue}>{featureFlagAdminCopy.valueTrue}</option>
                        <option value={featureFlagAdminMachine.falseValue}>{featureFlagAdminCopy.valueFalse}</option>
                      </select>
                    </div>

                    <div className={styles["ff-form-field"]}>
                      <label>{featureFlagAdminCopy.reasonLabel}</label>
                      <textarea
                        className={styles["ff-textarea"]}
                        placeholder={featureFlagAdminCopy.reasonPlaceholder}
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </div>

                    <div className={styles["ff-btn-group"]}>
                      <button
                        type="button"
                        className={`${styles["ff-btn"]} ${styles["ff-btn--primary"]}`}
                        disabled={busy || isScopeIdMissing || !isReasonValid}
                        onClick={triggerSaveOverride}
                      >
                        {featureFlagAdminCopy.saveOverride}
                      </button>

                      {explicitOverride && (
                        <button
                          type="button"
                          className={`${styles["ff-btn"]} ${styles["ff-btn--danger"]}`}
                          disabled={busy || isScopeIdMissing || !isReasonValid}
                          onClick={triggerDeleteOverride}
                        >
                          {featureFlagAdminCopy.removeOverride}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className={styles["ff-card"]}>
                  <h3 className={styles["ff-card__section-title"]}>
                    {featureFlagAdminCopy.activeOverridesTitle} ({selectedFlag.overrides.length})
                  </h3>
                  {selectedFlag.overrides.length === 0 ? (
                    <p className={styles["ff-empty-muted"]}>{featureFlagAdminCopy.noActiveOverrides}</p>
                  ) : (
                    <table className={styles["ff-table"]}>
                      <thead>
                        <tr>
                          <th>{featureFlagAdminCopy.scopeColumn}</th>
                          <th>{featureFlagAdminCopy.valueColumn}</th>
                          <th>{featureFlagAdminCopy.reasonColumn}</th>
                          <th>{featureFlagAdminCopy.updatedAtColumn}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedFlag.overrides.map((o) => (
                          <tr key={o.id}>
                            <td>
                              {o.scope.kind === featureFlagAdminMachine.globalKind
                                ? featureFlagAdminMachine.globalKind
                                : `${o.scope.kind}:${(o.scope as { id: string }).id}`}
                            </td>
                            <td>
                              <strong>{String(o.value)}</strong>
                            </td>
                            <td>{o.reason}</td>
                            <td>{new Date(o.updatedAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className={styles["ff-card"]}>
                  <h3 className={styles["ff-card__section-title"]}>{featureFlagAdminCopy.auditHistoryTitle}</h3>
                  {document.auditEvents && document.auditEvents.length > 0 ? (
                    <table className={styles["ff-audit-table"]}>
                      <thead>
                        <tr>
                          <th>{featureFlagAdminCopy.actionColumn}</th>
                          <th>{featureFlagAdminCopy.targetColumn}</th>
                          <th>{featureFlagAdminCopy.actorColumn}</th>
                          <th>{featureFlagAdminCopy.reasonColumn}</th>
                          <th>{featureFlagAdminCopy.timestampColumn}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {document.auditEvents.map((evt) => (
                          <tr key={evt.id}>
                            <td>
                              <strong>{evt.action}</strong>
                            </td>
                            <td>{evt.target_id}</td>
                            <td>{evt.actor_type}</td>
                            <td>{evt.reason ?? "—"}</td>
                            <td>{new Date(evt.created_at).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className={styles["ff-empty-muted"]}>{featureFlagAdminCopy.noAuditEvents}</p>
                  )}
                </div>
              </>
            ) : (
              <div className={styles["ff-card"]}>
                <p>{featureFlagAdminCopy.emptyBody}</p>
              </div>
            )}
          </section>
        </div>
      </main>

      {confirmDialog && (
        <div className={styles["ff-modal-overlay"]}>
          <div className={styles["ff-modal"]}>
            <div className={styles["ff-modal-header"]}>
              <ShieldWarning size={28} color="#b7791f" />
              <h3>{featureFlagAdminCopy.dangerousConfirmTitle}</h3>
            </div>
            <p>{featureFlagAdminCopy.dangerousConfirmWarning}</p>

            <div className={styles["ff-diff-box"]}>
              <div>
                <strong>{featureFlagAdminCopy.flagLabel}:</strong>
              </div>
              <div>{confirmDialog.flagKey}</div>

              <div>
                <strong>{featureFlagAdminCopy.scopeLabel}:</strong>
              </div>
              <div>{confirmDialog.scope.kind}</div>

              <div>
                <strong>{featureFlagAdminCopy.oldValueLabel}:</strong>
              </div>
              <div>{String(confirmDialog.oldValue)}</div>

              <div>
                <strong>{featureFlagAdminCopy.newValueLabel}:</strong>
              </div>
              <div>
                <strong>{String(confirmDialog.newValue)}</strong>
              </div>
            </div>

            <div className={`${styles["ff-btn-group"]} ${styles["ff-btn-group--right"]}`}>
              <button
                type="button"
                className={`${styles["ff-btn"]} ${styles["ff-btn--secondary"]}`}
                onClick={() => setConfirmDialog(null)}
              >
                {featureFlagAdminCopy.cancelButton}
              </button>
              <button
                type="button"
                className={`${styles["ff-btn"]} ${styles["ff-btn--danger"]}`}
                onClick={() => {
                  if (confirmDialog.action === featureFlagAdminMachine.actionPut) {
                    void executeSave(Boolean(confirmDialog.newValue));
                  } else {
                    void executeDelete();
                  }
                }}
              >
                {featureFlagAdminCopy.confirmButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
