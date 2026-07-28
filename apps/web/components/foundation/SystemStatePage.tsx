"use client";

import { ArrowClockwise, LockKey, Plugs, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { ActionLink, BrandLink } from "./Primitives";

const iconByKind = {
  forbidden: LockKey,
  missing: Plugs,
  error: WarningCircle,
  maintenance: ArrowClockwise,
  offline: Plugs,
};

export function SystemStatePage({
  kind,
  code,
  title,
  body,
  detail,
  actionLabel,
  actionHref,
  action,
}: Readonly<{
  kind: keyof typeof iconByKind;
  code: string;
  title: string;
  body: string;
  detail?: string;
  actionLabel: string;
  actionHref?: string;
  action?: () => void;
}>) {
  const Icon = iconByKind[kind];
  return (
    <main className="system-state" id="main-content">
      <header>
        <BrandLink prefetch={false} />
      </header>
      <section aria-labelledby="system-state-title">
        <div className="system-state__icon" aria-hidden="true">
          <Icon />
        </div>
        <p className="system-state__code">{code}</p>
        <h1 id="system-state-title">{title}</h1>
        <p>{body}</p>
        {detail ? <p className="system-state__detail">{detail}</p> : null}
        {actionHref ? (
          <ActionLink href={actionHref} prefetch={false}>
            {actionLabel}
          </ActionLink>
        ) : (
          <button className="foundation-action foundation-action--dark" type="button" onClick={action}>
            <span>{actionLabel}</span>
            <span className="foundation-action__icon" aria-hidden="true">
              <ArrowClockwise />
            </span>
          </button>
        )}
      </section>
    </main>
  );
}
