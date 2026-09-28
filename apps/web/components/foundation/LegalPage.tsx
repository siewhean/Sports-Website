import { SiteFooter, SiteHeader } from "./SiteChrome";

export function LegalPage({
  title,
  children,
  viewer = null,
}: Readonly<{ title: string; children: React.ReactNode; viewer?: { displayName: string } | null }>) {
  return (
    <div className="legal-page">
      <SiteHeader viewer={viewer} />
      <main id="main-content">
        <h1>{title}</h1>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
