import Link from "next/link";
import { messages } from "@matchday/ui";
import { BrandLink } from "./Primitives";

const productionRoutes = [
  { href: "/competitions", label: messages.navigation.public },
  { href: "/organiser", label: messages.navigation.organiser },
  { href: "/official", label: messages.navigation.official },
];

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
      <nav aria-label={messages.navigation.menu}>
        {productionRoutes.map((route) => (
          <Link key={route.href} href={route.href}>
            {route.label}
          </Link>
        ))}
      </nav>
      <Link className="site-header__access" href="/organiser">
        {viewer?.displayName ?? messages.navigation.signIn}
      </Link>
    </header>
  );
}

export function SiteFooter({ inverse = false }: { inverse?: boolean }) {
  return (
    <footer className={`site-footer${inverse ? " site-footer--inverse" : ""}`}>
      <BrandLink inverse={inverse} />
      <p>{messages.footer.product}</p>
      <nav aria-label={messages.navigation.legalAndService}>
        <Link href="/privacy">{messages.footer.privacy}</Link>
        <Link href="/cookies">{messages.footer.cookies}</Link>
        <Link href="/maintenance">{messages.footer.status}</Link>
      </nav>
    </footer>
  );
}
