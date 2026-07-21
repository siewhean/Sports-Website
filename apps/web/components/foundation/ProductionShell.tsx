import Link from "next/link";
import { messages, type ShellKind } from "@matchday/ui";
import { BrandLink } from "./Primitives";

const organiserLinks = messages.organiser.sections.map((label, index) => ({
  label,
  href: index === 0 ? "/organiser" : `/organiser#${label.toLowerCase()}`,
}));

export function ProductionShell({
  kind,
  title,
  subtitle,
  children,
  utility,
}: Readonly<{
  kind: ShellKind;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  utility?: React.ReactNode;
}>) {
  const navLabel =
    kind === "organiser"
      ? messages.organiser.navLabel
      : kind === "official"
        ? messages.official.navLabel
        : messages.public.navLabel;
  const links = kind === "organiser" ? organiserLinks : [{ href: "/official", label: messages.official.title }];

  return (
    <div className={`production-shell production-shell--${kind}`}>
      <a className="skip-link" href="#main-content">
        {messages.navigation.skip}
      </a>
      <header className="production-shell__header">
        <BrandLink />
        <div>
          <p>{subtitle}</p>
          <h1>{title}</h1>
        </div>
        {utility}
      </header>
      <div className="production-shell__body">
        <nav className="production-shell__rail" aria-label={navLabel}>
          {links.map((link, index) => (
            <Link href={link.href} key={link.href} aria-current={index === 0 ? "page" : undefined}>
              {link.label}
            </Link>
          ))}
          <Link href="/">{messages.brand.name}</Link>
        </nav>
        <main id="main-content" tabIndex={-1} className="production-shell__main">
          {children}
        </main>
      </div>
    </div>
  );
}
