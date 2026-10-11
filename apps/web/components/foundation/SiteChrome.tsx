import Link from "next/link";
import { messages } from "@matchday/ui";
import { BrandLink } from "./Primitives";
import { IdentityStatus } from "./IdentityStatus";
import { ThemeControl } from "./ThemeControl";

export const productionRoutes = [
  { href: "/competitions", label: messages.navigation.viewResults },
  { href: "/play", label: messages.navigation.play },
  { href: "/organiser", label: messages.navigation.organise },
  { href: "/official", label: messages.navigation.officiate },
] as const;

export function JourneyNavigation({ className = "" }: { className?: string }) {
  return (
    <nav className={className} aria-label={messages.navigation.journeys}>
      {productionRoutes.map((route) => (
        <Link key={route.href} href={route.href}>
          {route.label}
        </Link>
      ))}
    </nav>
  );
}

type SiteHeaderViewer = Readonly<{
  displayName: string;
}>;

export function SiteHeader({
  inverse = false,
  viewer = null,
}: {
  inverse?: boolean;
  viewer?: SiteHeaderViewer | null;
}) {
  return (
    <header className={`site-header${inverse ? " site-header--inverse" : ""}`}>
      <BrandLink inverse={inverse} />
      <JourneyNavigation className="site-header__journeys" />
      <div className="site-header__utilities">
        <ThemeControl />
        <IdentityStatus className="site-header__access" initialDisplayName={viewer?.displayName ?? null} />
      </div>
    </header>
  );
}

export function SiteFooter({ inverse = false }: { inverse?: boolean }) {
  return (
    <footer className={`site-footer${inverse ? " site-footer--inverse" : ""}`}>
      <BrandLink inverse={inverse} />
      <p>{messages.footer.product}</p>
      <nav aria-label={messages.navigation.legalAndService}>
        <Link href="/pricing">{messages.footer.pricing}</Link>
        <Link href="/privacy">{messages.footer.privacy}</Link>
        <Link href="/terms">{messages.footer.terms}</Link>
        <Link href="/cookies">{messages.footer.cookies}</Link>
        <Link href="/account">{messages.footer.account}</Link>
        <Link href="/maintenance">{messages.footer.status}</Link>
      </nav>
    </footer>
  );
}
