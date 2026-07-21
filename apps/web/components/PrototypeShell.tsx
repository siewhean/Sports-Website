"use client";

import { useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Lifebuoy, Trophy } from "@phosphor-icons/react";
import { translate as t } from "@matchday/ui";
import styles from "./PrototypeShell.module.css";
import primitiveStyles from "./prototype/PrototypePrimitives.module.css";

export const prototypeRoutes = [
  { href: "/setup", label: t("prototype.fe48ad8a445f") },
  { href: "/format", label: t("prototype.0e8c71c5f784") },
  { href: "/score", label: t("prototype.11b172ceab02") },
] as const satisfies ReadonlyArray<{ href: `/${string}`; label: string }>;

export function PrototypeShell({
  children,
  routeLabel,
  dark = false,
  scoring = false,
}: Readonly<{
  children: React.ReactNode;
  routeLabel: string;
  dark?: boolean;
  scoring?: boolean;
}>) {
  const pathname = usePathname();
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      scope.current?.setAttribute("data-hydrated", "true");
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.fromTo(
        "[data-prototype-entrance]",
        { y: 14 },
        { y: 0, duration: 0.42, ease: "power3.out", clearProps: "all" },
      );
    },
    { scope },
  );

  return (
    <div
      ref={scope}
      data-hydrated="false"
      className={`${styles.shell}${dark ? ` ${styles.dark}` : ""}${scoring ? ` ${styles.scoring}` : ""}`}
    >
      <a className="skip-link" href="#prototype-main">
        {t("prototype.3621235a9d0e")}
      </a>
      <header className={`${styles.header} app-header`}>
        <Link className={`${styles.wordmark} wordmark`} href="/setup" aria-label={t("prototype.e6fb05e8ca1f")}>
          <span className={`${styles.wordmarkMark} wordmark-mark`} aria-hidden="true">
            <Trophy weight="fill" />
          </span>
          {t("prototype.81d097dbe5b7")}
        </Link>
        <nav aria-label={t("prototype.16ef72356000")}>
          {prototypeRoutes.map((route) => (
            <Link key={route.href} href={route.href} aria-current={pathname === route.href ? "page" : undefined}>
              {route.label}
            </Link>
          ))}
        </nav>
        <div className={`${styles.headerMeta} header-meta`}>
          <span className={`${styles.competitionContext} competition-context`}>
            <span aria-hidden="true" />
            {t("prototype.1357967f45d5")}
          </span>
          <button className={primitiveStyles.iconButton} type="button" aria-label={t("prototype.389c375612b6")}>
            <Lifebuoy />
          </button>
          <span className={`${styles.avatar} avatar`} aria-label={t("prototype.0550d7e94c41")}>
            {t("prototype.b7aea05ac84d")}
          </span>
        </div>
      </header>
      <main id="prototype-main" aria-label={routeLabel} data-prototype-entrance>
        {children}
      </main>
    </div>
  );
}
