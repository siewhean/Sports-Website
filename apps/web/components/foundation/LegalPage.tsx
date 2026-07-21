import { SiteFooter, SiteHeader } from "./SiteChrome";

export function LegalPage({ title, children }: Readonly<{ title: string; children: React.ReactNode }>) {
  return (
    <div className="legal-page">
      <SiteHeader />
      <main id="main-content">
        <h1>{title}</h1>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
