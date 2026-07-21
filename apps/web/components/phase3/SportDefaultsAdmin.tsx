"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle, LockKey, ShieldWarning } from "@phosphor-icons/react";
import { displaySettingValue, phase3SettingsCopy } from "@/lib/phase3-sport-settings";
import {
  nextDraftDefinition,
  parseSportPackActivationReceipt,
  parseSportPackDraftReceipt,
  phase3AdminCopy,
  phase3AdminMachine,
  type SportDefaultsAdminDocument,
  type SportPackAdminState,
  type SportPackAdminVersion,
} from "@/lib/phase3-sport-pack-admin";
import { phase3Classes } from "./phase3Classes";
import styles from "./SportDefaultsAdmin.module.css";

const cx = (...values: Parameters<typeof phase3Classes>[1][]) => phase3Classes(styles, ...values);

const adminStateCopy: Record<Exclude<SportPackAdminState, "ready" | "loading">, { title: string; body: string }> = {
  empty: { title: phase3SettingsCopy.adminEmptyTitle, body: phase3SettingsCopy.adminEmptyBody },
  error: { title: phase3SettingsCopy.adminErrorTitle, body: phase3SettingsCopy.adminErrorBody },
  offline: { title: phase3SettingsCopy.adminOfflineTitle, body: phase3SettingsCopy.adminOfflineBody },
  conflict: { title: phase3AdminCopy.conflictTitle, body: phase3AdminCopy.conflictBody },
  permission: { title: phase3SettingsCopy.adminPermissionTitle, body: phase3SettingsCopy.adminPermissionBody },
  expired: { title: phase3AdminCopy.expiredTitle, body: phase3AdminCopy.expiredBody },
  revoked: { title: phase3AdminCopy.revokedTitle, body: phase3AdminCopy.revokedBody },
};

function commandState(status: number, payload: unknown): SportPackAdminState | null {
  if (status === 409) return phase3AdminMachine.conflict;
  if (status !== 401 && status !== 403) return null;
  const code =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    payload.error &&
    typeof payload.error === "object" &&
    "code" in payload.error &&
    typeof payload.error.code === "string"
      ? payload.error.code
      : "";
  return code.includes(phase3AdminMachine.expiredCode)
    ? phase3AdminMachine.expired
    : code.includes(phase3AdminMachine.revokedCode) || code.includes(phase3AdminMachine.inactiveCode)
      ? phase3AdminMachine.revoked
      : phase3AdminMachine.permission;
}

export function SportDefaultsAdmin({ document }: { document: SportDefaultsAdminDocument }) {
  const router = useRouter();
  const [versions, setVersions] = useState(document.versions);
  const [selectedKey, setSelectedKey] = useState(() => {
    const selected = document.versions.find((item) => item.sportCode === document.activeSportId);
    return selected ? `${selected.sportCode}:${selected.version}` : "";
  });
  const [draftVersion, setDraftVersion] = useState("");
  const [busy, setBusy] = useState<"save" | "activate" | null>(null);
  const [state, setState] = useState<SportPackAdminState>(document.state);
  const [message, setMessage] = useState("");
  const selected = useMemo(
    () => versions.find((item) => `${item.sportCode}:${item.version}` === selectedKey) ?? versions[0],
    [selectedKey, versions],
  );
  const draft = selected && draftVersion.trim() ? nextDraftDefinition(selected.definition, draftVersion.trim()) : null;

  if (state === "loading") return <AdminSkeleton />;
  if (state !== "ready") return <AdminState state={state} />;
  if (!selected) return <AdminState state={phase3AdminMachine.empty} />;

  async function saveDraft() {
    if (!document.canManage || !selected || !draft || busy) return;
    setBusy(phase3AdminMachine.save);
    setMessage("");
    try {
      const response = await fetch("/api/phase3/admin/sport-packs/drafts", {
        method: phase3AdminMachine.post,
        headers: { "content-type": phase3AdminMachine.applicationJson },
        body: JSON.stringify({ definition: draft }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setState(commandState(response.status, payload) ?? "error");
        return;
      }
      const receipt = parseSportPackDraftReceipt(payload);
      if (
        !receipt ||
        receipt.sportCode !== selected.sportCode ||
        receipt.version !== draft.version ||
        receipt.schemaVersion !== draft.schemaVersion
      ) {
        setMessage(phase3AdminCopy.commandInvalid);
        return;
      }
      const created: SportPackAdminVersion = {
        sportCode: receipt.sportCode,
        version: receipt.version,
        schemaVersion: receipt.schemaVersion,
        definition: draft,
        definitionHash: receipt.definitionHash,
        status: phase3AdminMachine.draft,
        revision: receipt.revision,
        createdBy: receipt.createdBy,
        createdAt: receipt.createdAt,
        activatedBy: null,
        activatedAt: null,
        supersededAt: null,
        supersededBy: null,
        supersededByVersion: null,
        readOnly: true,
      };
      setVersions((current) => [
        ...current.filter((item) => `${item.sportCode}:${item.version}` !== `${created.sportCode}:${created.version}`),
        created,
      ]);
      setSelectedKey(`${created.sportCode}:${created.version}`);
      setDraftVersion("");
      setMessage(phase3AdminCopy.draftSaved);
      router.replace(
        `/internal/sport-defaults?sport=${encodeURIComponent(created.sportCode)}&version=${encodeURIComponent(created.version)}`,
      );
    } catch {
      setState(phase3AdminMachine.offline);
    } finally {
      setBusy(null);
    }
  }

  async function activate() {
    if (!document.canManage || selected.status !== phase3AdminMachine.draft || busy) return;
    const expectedActiveVersion =
      versions.find((item) => item.sportCode === selected.sportCode && item.status === phase3AdminMachine.active)
        ?.version ?? null;
    setBusy(phase3AdminMachine.activate);
    setMessage("");
    try {
      const response = await fetch(
        `/api/phase3/admin/sport-packs/${encodeURIComponent(selected.sportCode)}/${encodeURIComponent(selected.version)}/activate`,
        {
          method: phase3AdminMachine.post,
          headers: { "content-type": phase3AdminMachine.applicationJson },
          body: JSON.stringify({ revision: selected.revision, expected_active_version: expectedActiveVersion }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setState(commandState(response.status, payload) ?? "error");
        return;
      }
      const receipt = parseSportPackActivationReceipt(payload);
      if (
        !receipt ||
        receipt.sportCode !== selected.sportCode ||
        receipt.version !== selected.version ||
        receipt.schemaVersion !== selected.schemaVersion ||
        receipt.definitionHash !== selected.definitionHash ||
        receipt.previousActiveVersion !== expectedActiveVersion
      ) {
        setMessage(phase3AdminCopy.commandInvalid);
        return;
      }
      setVersions((current) =>
        current.map((item) =>
          item === selected
            ? {
                ...item,
                status: phase3AdminMachine.active,
                revision: receipt.revision,
                activatedBy: receipt.activatedBy,
                activatedAt: receipt.activatedAt,
                supersededAt: null,
                supersededBy: null,
                supersededByVersion: null,
              }
            : item.sportCode === selected.sportCode && item.version === receipt.previousActiveVersion
              ? {
                  ...item,
                  status: phase3AdminMachine.superseded,
                  supersededAt: receipt.activatedAt,
                  supersededBy: receipt.activatedBy,
                  supersededByVersion: receipt.version,
                }
              : item,
        ),
      );
      setMessage(phase3AdminCopy.activated);
    } catch {
      setState(phase3AdminMachine.offline);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={cx("p3-admin")} id="main-content">
      <header className={cx("p3-admin__header")}>
        <Link className={cx("p3-admin__wordmark")} href="/">
          <span aria-hidden="true">{phase3SettingsCopy.brandMark}</span>
          {phase3SettingsCopy.brand}
        </Link>
        <span>{phase3SettingsCopy.internalDefaults}</span>
      </header>
      <div className={cx("p3-admin__body")}>
        <section className={cx("p3-admin__intro")}>
          <div>
            <p className={cx("p3-kicker")}>{phase3SettingsCopy.internalAdministration}</p>
            <h1>{phase3SettingsCopy.adminTitle}</h1>
            <p>{phase3SettingsCopy.adminIntro}</p>
          </div>
          <aside>
            <ShieldWarning aria-hidden="true" />
            <strong>{phase3SettingsCopy.provisional}</strong>
            <span>{phase3SettingsCopy.noAuthority}</span>
          </aside>
        </section>
        <div className={cx("p3-sport-tabs")} role="tablist" aria-label={phase3SettingsCopy.sportPacks}>
          {versions.map((item, index) => {
            const key = `${item.sportCode}:${item.version}`;
            const id = `sport-tab-${item.sportCode}-${item.version}`;
            return (
              <button
                key={key}
                id={id}
                role="tab"
                type="button"
                aria-selected={key === selectedKey}
                aria-controls="sport-pack-panel"
                tabIndex={key === selectedKey ? 0 : -1}
                onClick={() => {
                  setSelectedKey(key);
                  setDraftVersion("");
                }}
                onKeyDown={(event) => {
                  const nextIndex =
                    event.key === "ArrowRight"
                      ? (index + 1) % versions.length
                      : event.key === "ArrowLeft"
                        ? (index - 1 + versions.length) % versions.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? versions.length - 1
                            : null;
                  if (nextIndex === null) return;
                  event.preventDefault();
                  const next = versions[nextIndex];
                  if (!next) return;
                  const nextKey = `${next.sportCode}:${next.version}`;
                  setSelectedKey(nextKey);
                  setDraftVersion("");
                  window.document.getElementById(`sport-tab-${next.sportCode}-${next.version}`)?.focus();
                }}
              >
                {item.definition.displayName}
                <small>
                  {item.version} · {item.status}
                </small>
              </button>
            );
          })}
        </div>
        <p className={cx("p3-admin__live")} aria-live="polite">
          {message}
        </p>
        <div className={cx("p3-admin__grid")}>
          <section
            className={cx("p3-admin__settings")}
            id="sport-pack-panel"
            role="tabpanel"
            aria-labelledby={`sport-tab-${selected.sportCode}-${selected.version}`}
          >
            <header>
              <div>
                <span className={cx("p3-mode")}>
                  <CheckCircle weight="fill" aria-hidden="true" />
                  {selected.status === phase3AdminMachine.active ? phase3AdminCopy.active : phase3AdminCopy.draft}
                </span>
                <h2>{selected.definition.displayName}</h2>
                <p>
                  {phase3SettingsCopy.schema} {selected.schemaVersion} · {phase3SettingsCopy.pack} {selected.version}
                </p>
              </div>
            </header>
            <dl className={cx("p3-admin__meta")}>
              <div>
                <dt>{phase3AdminCopy.revision}</dt>
                <dd>{selected.revision}</dd>
              </div>
              <div>
                <dt>{phase3AdminCopy.definitionHash}</dt>
                <dd>{selected.definitionHash}</dd>
              </div>
            </dl>
            <ul>
              {Object.entries(selected.definition.recommendedSettings).map(([key, value]) => (
                <li key={key}>
                  <span>{selected.definition.settingsSchema[key]?.label ?? key}</span>
                  <strong>{displaySettingValue(value)}</strong>
                  <small>{selected.status}</small>
                </li>
              ))}
            </ul>
          </section>
          <aside className={cx("p3-admin__rail")}>
            <p className={cx("p3-kicker")}>{phase3AdminCopy.activationTitle}</p>
            <h2>{selected.status === phase3AdminMachine.active ? phase3AdminCopy.active : phase3AdminCopy.draft}</h2>
            <p>
              {selected.status === phase3AdminMachine.active
                ? phase3AdminCopy.activeTruth
                : phase3AdminCopy.activationReady}
            </p>
            <button
              className={cx("p3-button", "p3-button--secondary")}
              type="button"
              disabled={!document.canManage || selected.status !== phase3AdminMachine.draft || busy !== null}
              onClick={() => void activate()}
            >
              {busy === phase3AdminMachine.activate ? phase3AdminCopy.activating : phase3SettingsCopy.activate}
            </button>
            <small>{phase3AdminCopy.immutable}</small>
            <hr />
            <label>
              <span>{phase3AdminCopy.newVersion}</span>
              <input
                value={draftVersion}
                onChange={(event) => setDraftVersion(event.target.value)}
                placeholder={phase3AdminCopy.versionPlaceholder}
                disabled={!document.canManage || busy !== null}
              />
            </label>
            <p>{phase3AdminCopy.newVersionHelp}</p>
            <button
              className={cx("p3-button", "p3-button--primary")}
              type="button"
              disabled={!document.canManage || !draft || draft.version === selected.version || busy !== null}
              onClick={() => void saveDraft()}
            >
              {busy === phase3AdminMachine.save ? phase3AdminCopy.saving : phase3SettingsCopy.saveDraft}
            </button>
          </aside>
        </div>
      </div>
    </main>
  );
}

function AdminState({ state }: { state: Exclude<SportPackAdminState, "ready" | "loading"> }) {
  const copy = adminStateCopy[state];
  return (
    <main className={cx("p3-admin-state")} id="main-content">
      <LockKey aria-hidden="true" />
      <p className={cx("p3-kicker")}>{phase3SettingsCopy.internalAdministration}</p>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <small>{phase3SettingsCopy.noAuthority}</small>
    </main>
  );
}

function AdminSkeleton() {
  return (
    <main className={cx("p3-skeleton")} aria-busy="true" aria-label={phase3SettingsCopy.loadingAdmin}>
      <header className={cx("p3-skeleton-header")} />
      <div className={cx("p3-skeleton-body")}>
        <div className={cx("p3-skeleton-main")}>
          <span />
          {Array.from({ length: 7 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <aside className={cx("p3-skeleton-rail")}>
          <span />
          <span />
        </aside>
      </div>
    </main>
  );
}
