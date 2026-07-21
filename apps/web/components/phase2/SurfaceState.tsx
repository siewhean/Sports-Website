import {
  ArrowClockwise,
  CloudSlash,
  EyeSlash,
  LockKey,
  Plus,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { phase2Copy, type SurfaceState } from "@/lib/phase2";

const stateContent: Record<Exclude<SurfaceState, "ready">, { title: string; body: string; action?: string }> = {
  loading: { title: phase2Copy.loadingTitle, body: phase2Copy.loadingBody },
  empty: { title: phase2Copy.emptyTitle, body: phase2Copy.emptyBody, action: phase2Copy.continue },
  error: { title: phase2Copy.errorTitle, body: phase2Copy.errorBody, action: phase2Copy.retry },
  offline: { title: phase2Copy.offlineTitle, body: phase2Copy.offlineBody, action: phase2Copy.retry },
  conflict: { title: phase2Copy.conflictTitle, body: phase2Copy.conflictBody, action: phase2Copy.reviewRevision },
  "read-only": { title: phase2Copy.readOnlyTitle, body: phase2Copy.readOnlyBody, action: phase2Copy.createRevision },
  permission: { title: phase2Copy.permissionTitle, body: phase2Copy.permissionBody, action: phase2Copy.requestAccess },
};

const stateIcons = {
  loading: SpinnerGap,
  empty: Plus,
  error: WarningCircle,
  offline: CloudSlash,
  conflict: ArrowClockwise,
  "read-only": EyeSlash,
  permission: LockKey,
} as const;

export function SurfaceStatePanel({ state }: { state: Exclude<SurfaceState, "ready"> }) {
  const content = stateContent[state];
  const Icon = stateIcons[state];

  if (state === "loading") {
    return (
      <section className="p2-state p2-state--loading" role="status" aria-label={content.title}>
        <span className="p2-skeleton p2-skeleton--title" />
        <span className="p2-skeleton" />
        <span className="p2-skeleton p2-skeleton--short" />
        <span className="visually-hidden">{content.body}</span>
      </section>
    );
  }

  return (
    <section className={`p2-state p2-state--${state}`} role={state === "error" ? "alert" : "status"}>
      <span className="p2-state__icon" aria-hidden="true">
        <Icon weight="light" />
      </span>
      <div>
        <h2>{content.title}</h2>
        <p>{content.body}</p>
      </div>
      {content.action ? (
        <button className="p2-button p2-button--secondary" type="button">
          {content.action}
        </button>
      ) : null}
    </section>
  );
}
