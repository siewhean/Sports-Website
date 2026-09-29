"use client";

import { ArrowClockwise, LockKey, Plugs, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { ActionLink } from "./Primitives";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import styles from "./SystemStatePage.module.css";

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
    <div className={styles.page}>
      <SiteHeader />
      <main className={styles.main} id="main-content" aria-labelledby="system-state-title">
        <div className={styles.icon} aria-hidden="true">
          <Icon />
        </div>
        <p className={styles.code}>{code}</p>
        <h1 id="system-state-title">{title}</h1>
        <p>{body}</p>
        {detail ? <p className={styles.detail}>{detail}</p> : null}
        {actionHref ? (
          <ActionLink href={actionHref} prefetch={false}>
            {actionLabel}
          </ActionLink>
        ) : (
          <button className={styles.action} type="button" onClick={action}>
            <span>{actionLabel}</span>
            <span aria-hidden="true">
              <ArrowClockwise />
            </span>
          </button>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
