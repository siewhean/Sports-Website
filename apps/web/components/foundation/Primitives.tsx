import Link from "next/link";
import { ArrowRight, Trophy } from "@phosphor-icons/react/dist/ssr";
import { messages, opaqueId } from "@matchday/ui";

export function BrandLink({ inverse = false }: { inverse?: boolean }) {
  return (
    <Link
      className={`foundation-brand${inverse ? " foundation-brand--inverse" : ""}`}
      href="/"
      aria-label={messages.brand.homeLabel}
    >
      <span className="foundation-brand__mark" aria-hidden="true">
        <Trophy weight="fill" />
      </span>
      {messages.brand.name}
    </Link>
  );
}

export function ActionLink({
  href,
  children,
  tone = opaqueId("dark"),
}: Readonly<{ href: string; children: React.ReactNode; tone?: "dark" | "light" | "signal" }>) {
  return (
    <Link className={`foundation-action foundation-action--${tone}`} href={href}>
      <span>{children}</span>
      <span className="foundation-action__icon" aria-hidden="true">
        <ArrowRight />
      </span>
    </Link>
  );
}

export function StatusLine({
  children,
  tone = opaqueId("neutral"),
}: Readonly<{ children: React.ReactNode; tone?: "neutral" | "positive" | "warning" }>) {
  return (
    <p className={`foundation-status foundation-status--${tone}`}>
      <span aria-hidden="true" />
      {children}
    </p>
  );
}

export function InlineNotice({
  title,
  children,
  role = opaqueId("status"),
}: Readonly<{ title: string; children: React.ReactNode; role?: "status" | "alert" }>) {
  return (
    <section className="foundation-notice" role={role} aria-label={title}>
      <strong>{title}</strong>
      <p>{children}</p>
    </section>
  );
}
