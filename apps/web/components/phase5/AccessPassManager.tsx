"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Check, Clock, Copy, DownloadSimple, Printer, QrCode, ShieldWarning, X } from "@phosphor-icons/react";
import { toDataURL, toString as qrToString } from "qrcode";
import { translate as t } from "@matchday/ui";
import type { CompetitionView, MatchView } from "@/lib/phase2";
import { LatestRequestFence } from "@/lib/latest-request";
import {
  gateCAccessMachine,
  gateCAccessPermissions,
  parseIssuedAccessPass,
  parseRevokedPass,
  parseRotatedFallback,
  parseTakeoverDecision,
  parseTakeoverRequests,
  type IssuedAccessPass,
  type TakeoverRequestSummary,
} from "@/lib/gate-c-access";

type PassSummary = NonNullable<CompetitionView["accessPasses"]>[number];

const copy = {
  title: t("prototype.e5093e5ae8a8"),
  body: t("prototype.b70973329dff"),
  issue: t("prototype.4bcf875e3240"),
  match: t("prototype.03c0e806becb"),
  role: t("prototype.001fbe38fbae"),
  scorekeeper: t("prototype.36e58ac52deb"),
  viewer: t("prototype.55841930c576"),
  expires: t("prototype.f6725f3af08a"),
  cancel: t("prototype.19766ed6ccb2"),
  create: t("prototype.b194adee9de8"),
  issuing: t("prototype.0247fb131088"),
  oneTime: t("prototype.5f3ae4e00f66"),
  oneTimeBody: t("prototype.cf7d850c4534"),
  scan: t("prototype.ee618dd8488a"),
  textFallback: t("prototype.d0644c0560bb"),
  fallbackCode: t("prototype.df4eb28e0ddf"),
  copyLink: t("prototype.dbf362d4f210"),
  copyCode: t("prototype.f35c40de4435"),
  download: t("prototype.fed7e99c6768"),
  print: t("prototype.df0fe79898ef"),
  close: t("prototype.7d9eb7acb13e"),
  rotate: t("prototype.f13215c26bf7"),
  revoke: t("prototype.87e6d00bbf53"),
  active: t("prototype.92340695899b"),
  revoked: t("prototype.f6f738d04392"),
  noPass: t("prototype.8c15d5518420"),
  confirmRevoke: t("prototype.8869454ef66d"),
  confirmRevokeBody: t("prototype.f04ec27468ea"),
  reason: t("prototype.f81ab834de5f"),
  confirm: t("prototype.0ceea8c63162"),
  failed: t("prototype.3d7986d56035"),
  history: t("prototype.1e9e73ee4d44"),
  expired: t("prototype.424a2551d356"),
  status: t("prototype.920e413c7d41"),
} as const;

const takeoverCopy = {
  title: t("prototype.89e1008ca8ab"),
  body: t("prototype.df3bfb46cb4e"),
  empty: t("prototype.3583bb907900"),
  pendingEvents: t("prototype.c63b97b0261b"),
  unknownState: t("prototype.f014c1d19dd4"),
  pendingState: t("prototype.99326827179a"),
  clearState: t("prototype.ae7f74bbf8a3"),
  reviewTitle: t("prototype.f039af55d522"),
  requester: t("prototype.415a613c7b2c"),
  incumbent: t("prototype.0135971b2c26"),
  requested: t("prototype.2d9e28289fac"),
  review: t("prototype.aff0766a5290"),
  warning: t("prototype.6ad189f5cd95"),
  warningBody: t("prototype.987424d2641c"),
  acknowledge: t("prototype.b4c148e8c017"),
  reason: t("prototype.733f30ba30b5"),
  reasonHint: t("prototype.57c9e612a97f"),
  approve: t("prototype.38fa63b79f2f"),
  deny: t("prototype.4ff70e623aef"),
  conflictApproved: t("prototype.92f0e0c3c260"),
  approved: t("prototype.9cc0dc109827"),
  denied: t("prototype.dca79b502803"),
  refreshed: t("prototype.9997194c83d7"),
  unknownDevice: t("prototype.06c4a77e4b3e"),
} as const;

function localExpiry(): string {
  const expiry = new Date(Date.now() + 2 * 60 * 60 * 1_000);
  const offset = expiry.getTimezoneOffset() * 60_000;
  return new Date(expiry.getTime() - offset).toISOString().slice(0, 16);
}

function absoluteScoringUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function AccessPassManager({
  competitionId,
  matches,
  initialPasses,
  canEdit,
  enableRemoteTakeovers = true,
}: {
  competitionId: string;
  matches: readonly MatchView[];
  initialPasses: readonly PassSummary[];
  canEdit: boolean;
  enableRemoteTakeovers?: boolean;
}) {
  const [passes, setPasses] = useState<PassSummary[]>([...initialPasses]);
  const [matchId, setMatchId] = useState(matches[0]?.id ?? "");
  const [role, setRole] = useState<"scorekeeper" | "viewer">(gateCAccessMachine.scorekeeper);
  const [expiresAt, setExpiresAt] = useState("");
  const [issued, setIssued] = useState<IssuedAccessPass | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<PassSummary | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [takeovers, setTakeovers] = useState<TakeoverRequestSummary[]>([]);
  const [reviewing, setReviewing] = useState<TakeoverRequestSummary | null>(null);
  const [decisionReason, setDecisionReason] = useState("");
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const issueDialog = useRef<HTMLDialogElement>(null);
  const revealDialog = useRef<HTMLDialogElement>(null);
  const revokeDialog = useRef<HTMLDialogElement>(null);
  const takeoverDialog = useRef<HTMLDialogElement>(null);
  const takeoverReason = useRef<HTMLTextAreaElement>(null);
  const takeoverReturnTarget = useRef<HTMLButtonElement | null>(null);
  const issueButton = useRef<HTMLButtonElement>(null);
  const revealClose = useRef<HTMLButtonElement>(null);
  const revealReturnTarget = useRef<HTMLButtonElement | null>(null);
  const takeoverLoadFence = useRef(new LatestRequestFence());

  const loadTakeovers = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`/api/gate-c/competitions/${encodeURIComponent(competitionId)}/takeover-requests`, {
        cache: gateCAccessMachine.noStore,
        credentials: gateCAccessMachine.sameOrigin,
        signal,
      });
      const payload = (await response.json().catch(() => null)) as { takeover_requests?: unknown } | null;
      const requests = parseTakeoverRequests(payload?.takeover_requests);
      if (!response.ok || !requests) throw new Error(copy.failed);
      return requests;
    },
    [competitionId],
  );

  useEffect(() => {
    if (!enableRemoteTakeovers) return;
    const loadFence = takeoverLoadFence.current;
    const refresh = () => {
      void loadFence
        .run(
          (signal) => loadTakeovers(signal),
          (requests) => setTakeovers(requests),
        )
        .catch(() => {
          setAnnouncement(copy.failed);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    const visibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      loadFence.cancel();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enableRemoteTakeovers, loadTakeovers]);

  useEffect(() => {
    if (!issued?.qrPath) return;
    let active = true;
    void toDataURL(absoluteScoringUrl(issued.qrPath), {
      errorCorrectionLevel: gateCAccessMachine.qrCorrectionLevel,
      margin: 3,
      width: 320,
      color: { dark: "#101b19", light: "#ffffff" },
    }).then((value) => {
      if (active) setQrDataUrl(value);
    });
    return () => {
      active = false;
    };
  }, [issued]);

  useEffect(() => {
    if (!issued || !revealDialog.current?.open) return;
    const focusFrame = window.requestAnimationFrame(() => revealClose.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [issued]);

  const openIssue = () => {
    setAnnouncement("");
    if (!expiresAt) setExpiresAt(localExpiry());
    issueDialog.current?.showModal();
  };

  const closeIssue = () => {
    issueDialog.current?.close();
    window.requestAnimationFrame(() => issueButton.current?.focus());
  };

  const issuePass = async () => {
    if (!matchId || !expiresAt) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/matches/${encodeURIComponent(matchId)}/access-passes`,
        {
          method: gateCAccessMachine.post,
          credentials: gateCAccessMachine.sameOrigin,
          headers: { "content-type": gateCAccessMachine.contentType },
          body: JSON.stringify({
            role,
            expiresAt: new Date(expiresAt).toISOString(),
            idempotencyKey: crypto.randomUUID(),
          }),
        },
      );
      const result = parseIssuedAccessPass(await response.json().catch(() => null));
      if (!response.ok || !result || result.duplicate) throw new Error(copy.failed);
      setIssued(result);
      setPasses((current) => [
        {
          id: result.id,
          matchId: result.matchId,
          role: result.role,
          displayCode: "••••••••••••",
          expiresAt: new Date(result.expiresAt).toLocaleString(),
          revoked: false,
          status: gateCAccessMachine.active,
        },
        ...current.filter((pass) => pass.id !== result.id),
      ]);
      issueDialog.current?.close();
      revealReturnTarget.current = issueButton.current;
      revealDialog.current?.showModal();
      setAnnouncement(t("prototype.8a569cab1b79"));
    } catch {
      setAnnouncement(copy.failed);
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    setAnnouncement(message);
  };

  const downloadQr = async () => {
    if (!issued?.qrPath) return;
    const svg = await qrToString(absoluteScoringUrl(issued.qrPath), {
      type: "svg",
      errorCorrectionLevel: gateCAccessMachine.qrCorrectionLevel,
      margin: 3,
      color: { dark: "#101b19", light: "#ffffff" },
    });
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const anchor = document.createElement(gateCAccessMachine.anchor);
    anchor.href = url;
    anchor.download = `matchday-${issued.matchId}-access.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(t("prototype.0511ee34d2c7"));
  };

  const rotate = async (passId: string, returnTarget: HTMLButtonElement) => {
    revealReturnTarget.current = returnTarget;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/access-passes/${encodeURIComponent(passId)}/fallback-code/rotate`,
        {
          method: gateCAccessMachine.post,
          credentials: gateCAccessMachine.sameOrigin,
          headers: { "content-type": gateCAccessMachine.contentType },
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        },
      );
      const result = parseRotatedFallback(await response.json().catch(() => null));
      if (!response.ok || !result || !result.shortCode) throw new Error(copy.failed);
      const pass = passes.find((candidate) => candidate.id === passId);
      if (!pass) throw new Error(copy.failed);
      setIssued({
        id: pass.id,
        matchId: pass.matchId,
        role: pass.role,
        permissions:
          pass.role === gateCAccessMachine.viewer
            ? [...gateCAccessPermissions.viewer]
            : [...gateCAccessPermissions.scorekeeper],
        expiresAt: pass.expiresAt,
        revoked: false,
        token: null,
        shortCode: result.shortCode,
        qrPath: null,
        duplicate: result.duplicate,
      });
      revealDialog.current?.showModal();
      setAnnouncement(t("prototype.b67983781ade"));
    } catch {
      setAnnouncement(copy.failed);
    } finally {
      setBusy(false);
    }
  };

  const closeReveal = () => {
    revealDialog.current?.close();
    setIssued(null);
    setQrDataUrl("");
    const returnTarget = revealReturnTarget.current?.isConnected ? revealReturnTarget.current : issueButton.current;
    revealReturnTarget.current = null;
    window.requestAnimationFrame(() => returnTarget?.focus());
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/access-passes/${encodeURIComponent(revoking.id)}`,
        {
          method: gateCAccessMachine.delete,
          credentials: gateCAccessMachine.sameOrigin,
          headers: { "content-type": gateCAccessMachine.contentType },
          body: JSON.stringify({ reason: revokeReason.trim() }),
        },
      );
      const result = parseRevokedPass(await response.json().catch(() => null));
      if (!response.ok || !result) throw new Error(copy.failed);
      setPasses((current) =>
        current.map((pass) =>
          pass.id === revoking.id ? { ...pass, revoked: true, status: gateCAccessMachine.revoked } : pass,
        ),
      );
      revokeDialog.current?.close();
      setRevoking(null);
      setRevokeReason("");
      setAnnouncement(t("prototype.2a26a65cde7e"));
    } catch {
      setAnnouncement(copy.failed);
    } finally {
      setBusy(false);
    }
  };

  const openTakeover = (request: TakeoverRequestSummary, target: HTMLButtonElement) => {
    takeoverReturnTarget.current = target;
    setReviewing(request);
    setDecisionReason("");
    setOverrideAcknowledged(false);
    setDecisionError("");
    takeoverDialog.current?.showModal();
    window.requestAnimationFrame(() => takeoverReason.current?.focus());
  };

  const closeTakeover = () => {
    takeoverDialog.current?.close();
    setReviewing(null);
    setDecisionReason("");
    setOverrideAcknowledged(false);
    setDecisionError("");
    window.requestAnimationFrame(() => takeoverReturnTarget.current?.focus());
  };

  const decideTakeover = async (decision: "approve" | "deny") => {
    if (!reviewing) return;
    const reason = decisionReason.trim();
    const requiresOverride = reviewing.incumbentPendingState !== gateCAccessMachine.none;
    if (reason.length < 3 || (decision === gateCAccessMachine.approve && requiresOverride && !overrideAcknowledged)) {
      setDecisionError(takeoverCopy.reasonHint);
      return;
    }
    setBusy(true);
    setDecisionError("");
    try {
      const response = await fetch(
        `/api/gate-c/competitions/${encodeURIComponent(competitionId)}/takeover-requests/${encodeURIComponent(reviewing.id)}/${decision}`,
        {
          method: gateCAccessMachine.post,
          credentials: gateCAccessMachine.sameOrigin,
          headers: { "content-type": gateCAccessMachine.contentType },
          body: JSON.stringify({ reason, overrideAcknowledged }),
        },
      );
      const result = parseTakeoverDecision(await response.json().catch(() => null));
      if (!response.ok || !result) throw new Error(copy.failed);
      takeoverLoadFence.current.cancel();
      setTakeovers((current) =>
        current.map((request) => (request.id === result.id ? { ...request, status: result.status } : request)),
      );
      setAnnouncement(
        result.status === gateCAccessMachine.approved
          ? result.conflictId
            ? takeoverCopy.conflictApproved
            : takeoverCopy.approved
          : takeoverCopy.denied,
      );
      closeTakeover();
    } catch {
      setDecisionError(copy.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p2-access p5-access">
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <header>
        <QrCode />
        <div>
          <h2>{copy.title}</h2>
          <p>{copy.body}</p>
        </div>
        <button
          ref={issueButton}
          className="p2-button p2-button--dark"
          type="button"
          onClick={openIssue}
          disabled={!canEdit || !matches.length}
        >
          {copy.issue}
        </button>
      </header>
      {matches.slice(0, 8).map((match) => {
        const pass = passes.find(
          (candidate) => candidate.matchId === match.id && candidate.status === gateCAccessMachine.active,
        );
        return (
          <div key={match.id}>
            <span>
              <strong>{match.label}</strong>
              <small>
                {match.home} · {match.away}
              </small>
            </span>
            <code>{pass?.displayCode ?? copy.noPass}</code>
            <span>
              <Clock />
              {pass ? `${copy.expires} ${pass.expiresAt}` : match.time}
            </span>
            {pass ? <small>{pass.role === gateCAccessMachine.viewer ? copy.viewer : copy.scorekeeper}</small> : null}
          </div>
        );
      })}
      <section className="p5-access-history" aria-labelledby="access-pass-history-title">
        <h2 id="access-pass-history-title">{copy.history}</h2>
        {passes.length ? (
          <ol>
            {passes.map((pass) => {
              const match = matches.find((candidate) => candidate.id === pass.matchId);
              const matchLabel = match?.label ?? pass.matchId;
              const statusLabel =
                pass.status === gateCAccessMachine.revoked
                  ? copy.revoked
                  : pass.status === gateCAccessMachine.expired
                    ? copy.expired
                    : copy.active;
              const inactive = pass.status !== gateCAccessMachine.active;
              return (
                <li key={pass.id}>
                  <span>
                    <strong>{matchLabel}</strong>
                    <small>{pass.role === gateCAccessMachine.viewer ? copy.viewer : copy.scorekeeper}</small>
                  </span>
                  <span>
                    <strong>{copy.status}</strong>
                    <small>{statusLabel}</small>
                  </span>
                  <span>
                    <Clock />
                    {copy.expires} {pass.expiresAt}
                  </span>
                  <span className="p5-access__actions">
                    <button
                      type="button"
                      disabled={!canEdit || inactive}
                      aria-label={t("prototype.ff8f355c93c1", { match: matchLabel })}
                      onClick={(event) => void rotate(pass.id, event.currentTarget)}
                    >
                      {copy.rotate}
                    </button>
                    <button
                      type="button"
                      disabled={!canEdit || inactive}
                      aria-label={t("prototype.a644d789ceef", { match: matchLabel })}
                      onClick={() => {
                        setRevoking(pass);
                        revokeDialog.current?.showModal();
                      }}
                    >
                      {copy.revoke}
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p>{copy.noPass}</p>
        )}
      </section>
      <section className="p5-takeovers" aria-labelledby="takeover-requests-title">
        <header>
          <div>
            <h2 id="takeover-requests-title">{takeoverCopy.title}</h2>
            <p>{takeoverCopy.body}</p>
          </div>
        </header>
        {takeovers.filter((request) => request.status === gateCAccessMachine.pending).length ? (
          <ol>
            {takeovers
              .filter((request) => request.status === gateCAccessMachine.pending)
              .map((request) => {
                const match = matches.find((candidate) => candidate.id === request.matchId);
                const pendingState =
                  request.incumbentPendingState === gateCAccessMachine.unknown
                    ? takeoverCopy.unknownState
                    : request.incumbentPendingState === gateCAccessMachine.present
                      ? takeoverCopy.pendingState
                      : takeoverCopy.clearState;
                return (
                  <li key={request.id}>
                    <span>
                      <strong>{match?.label ?? request.matchId}</strong>
                      <small>{request.requestingDeviceLabel ?? takeoverCopy.unknownDevice}</small>
                    </span>
                    <span>
                      <strong>{pendingState}</strong>
                      <small>
                        {request.requesterPendingEventCount} {takeoverCopy.pendingEvents}
                      </small>
                    </span>
                    <time dateTime={request.requestedAt}>{new Date(request.requestedAt).toLocaleString()}</time>
                    <button
                      className="p2-button p2-button--secondary"
                      type="button"
                      disabled={!canEdit}
                      onClick={(event) => openTakeover(request, event.currentTarget)}
                    >
                      {takeoverCopy.review}
                    </button>
                  </li>
                );
              })}
          </ol>
        ) : (
          <p>{takeoverCopy.empty}</p>
        )}
      </section>

      <dialog ref={issueDialog} className="p5-access-dialog" aria-labelledby="issue-pass-title">
        <form method={gateCAccessMachine.dialog} onSubmit={(event) => event.preventDefault()}>
          <header>
            <h2 id="issue-pass-title">{copy.create}</h2>
            <button type="button" aria-label={copy.close} onClick={closeIssue}>
              <X />
            </button>
          </header>
          <label>
            <span>{copy.match}</span>
            <select value={matchId} onChange={(event) => setMatchId(event.target.value)}>
              {matches.map((match) => (
                <option key={match.id} value={match.id}>
                  {match.label} · {match.home} {t("prototype.f130559f0e7f")} {match.away}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{copy.role}</span>
            <select value={role} onChange={(event) => setRole(event.target.value as "scorekeeper" | "viewer")}>
              <option value={gateCAccessMachine.scorekeeper}>{copy.scorekeeper}</option>
              <option value={gateCAccessMachine.viewer}>{copy.viewer}</option>
            </select>
          </label>
          <label>
            <span>{copy.expires}</span>
            <input
              type="datetime-local"
              value={expiresAt}
              min={localExpiry().slice(0, 10)}
              onChange={(event) => setExpiresAt(event.target.value)}
              required
            />
          </label>
          <footer>
            <button className="p2-button p2-button--secondary" type="button" onClick={closeIssue}>
              {copy.cancel}
            </button>
            <button
              className="p2-button p2-button--dark"
              type="button"
              onClick={() => void issuePass()}
              disabled={busy || !expiresAt}
            >
              {busy ? copy.issuing : copy.create}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={revealDialog}
        className="p5-access-dialog p5-access-reveal"
        aria-labelledby="issued-pass-title"
        onCancel={(event) => {
          event.preventDefault();
          closeReveal();
        }}
      >
        {issued ? (
          <section>
            <header>
              <span aria-hidden="true">
                <Check />
              </span>
              <div>
                <h2 id="issued-pass-title">{copy.oneTime}</h2>
                <p>{issued.qrPath ? copy.oneTimeBody : t("prototype.b67983781ade")}</p>
              </div>
            </header>
            {qrDataUrl ? <Image unoptimized src={qrDataUrl} alt={copy.scan} width={320} height={320} /> : null}
            <dl>
              {issued.qrPath ? (
                <div>
                  <dt>{copy.textFallback}</dt>
                  <dd>
                    <code>{absoluteScoringUrl(issued.qrPath)}</code>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>{copy.fallbackCode}</dt>
                <dd>
                  <code>{issued.shortCode ?? "—"}</code>
                </dd>
              </div>
            </dl>
            <div className="p5-access-reveal__actions">
              {issued.qrPath ? (
                <button
                  type="button"
                  onClick={() => void copyValue(absoluteScoringUrl(issued.qrPath!), t("prototype.2bcf8cd15d44"))}
                >
                  <Copy />
                  {copy.copyLink}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => issued.shortCode && void copyValue(issued.shortCode, t("prototype.cf48948c8087"))}
              >
                <Copy />
                {copy.copyCode}
              </button>
              {issued.qrPath ? (
                <button type="button" onClick={() => void downloadQr()}>
                  <DownloadSimple />
                  {copy.download}
                </button>
              ) : null}
              <button type="button" onClick={() => window.print()}>
                <Printer />
                {copy.print}
              </button>
            </div>
            <button ref={revealClose} className="p2-button p2-button--dark" type="button" onClick={closeReveal}>
              {copy.close}
            </button>
          </section>
        ) : null}
      </dialog>

      <dialog ref={revokeDialog} className="p5-access-dialog" aria-labelledby="revoke-pass-title">
        <form method={gateCAccessMachine.dialog} onSubmit={(event) => event.preventDefault()}>
          <header>
            <ShieldWarning />
            <div>
              <h2 id="revoke-pass-title">{copy.confirmRevoke}</h2>
              <p>{copy.confirmRevokeBody}</p>
            </div>
          </header>
          <label>
            <span>{copy.reason}</span>
            <textarea value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} maxLength={500} />
          </label>
          <footer>
            <button
              className="p2-button p2-button--secondary"
              type="button"
              onClick={() => {
                revokeDialog.current?.close();
                setRevoking(null);
              }}
            >
              {copy.cancel}
            </button>
            <button
              className="p2-button p2-button--dark"
              type="button"
              disabled={busy}
              onClick={() => void confirmRevoke()}
            >
              {copy.confirm}
            </button>
          </footer>
        </form>
      </dialog>
      <dialog
        ref={takeoverDialog}
        className="p5-access-dialog p5-takeover-dialog"
        aria-labelledby="takeover-review-title"
        onCancel={(event) => {
          event.preventDefault();
          closeTakeover();
        }}
      >
        {reviewing ? (
          <form method={gateCAccessMachine.dialog} onSubmit={(event) => event.preventDefault()}>
            <header>
              <ShieldWarning />
              <div>
                <h2 id="takeover-review-title">{takeoverCopy.reviewTitle}</h2>
                <p>{takeoverCopy.body}</p>
              </div>
              <button type="button" aria-label={copy.close} onClick={closeTakeover}>
                <X />
              </button>
            </header>
            <dl>
              <div>
                <dt>{takeoverCopy.requester}</dt>
                <dd>{reviewing.requestingDeviceLabel ?? takeoverCopy.unknownDevice}</dd>
              </div>
              <div>
                <dt>{takeoverCopy.incumbent}</dt>
                <dd>{reviewing.incumbentDeviceLabel ?? takeoverCopy.unknownDevice}</dd>
              </div>
              <div>
                <dt>{takeoverCopy.requested}</dt>
                <dd>{new Date(reviewing.requestedAt).toLocaleString()}</dd>
              </div>
            </dl>
            {reviewing.incumbentPendingState !== gateCAccessMachine.none ? (
              <section className="p5-takeover-warning" role="alert">
                <strong>{takeoverCopy.warning}</strong>
                <p>{takeoverCopy.warningBody}</p>
                <label>
                  <input
                    type="checkbox"
                    checked={overrideAcknowledged}
                    onChange={(event) => setOverrideAcknowledged(event.target.checked)}
                  />
                  <span>{takeoverCopy.acknowledge}</span>
                </label>
              </section>
            ) : null}
            <label>
              <span>{takeoverCopy.reason}</span>
              <textarea
                ref={takeoverReason}
                value={decisionReason}
                onChange={(event) => setDecisionReason(event.target.value)}
                aria-invalid={Boolean(decisionError)}
                aria-describedby="takeover-reason-hint takeover-decision-error"
                minLength={3}
                maxLength={500}
                required
              />
              <small id="takeover-reason-hint">{takeoverCopy.reasonHint}</small>
              {decisionError ? (
                <em id="takeover-decision-error" role="alert">
                  {decisionError}
                </em>
              ) : null}
            </label>
            <footer>
              <button
                className="p2-button p2-button--secondary"
                type="button"
                disabled={busy}
                onClick={() => void decideTakeover(gateCAccessMachine.deny)}
              >
                {takeoverCopy.deny}
              </button>
              <button
                className="p2-button p2-button--dark"
                type="button"
                disabled={
                  busy ||
                  decisionReason.trim().length < 3 ||
                  (reviewing.incumbentPendingState !== gateCAccessMachine.none && !overrideAcknowledged)
                }
                onClick={() => void decideTakeover(gateCAccessMachine.approve)}
              >
                {takeoverCopy.approve}
              </button>
            </footer>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}
