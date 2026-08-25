import { messages } from "@matchday/ui";

export const metadata = {
  title: `${messages.support.title} · ${messages.brand.name}`,
  description: messages.support.subtitle,
};

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-12 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{messages.support.title}</h1>
          <p className="mt-3 text-lg text-neutral-400">{messages.support.subtitle}</p>
        </header>

        <section className="mb-12">
          <h2 className="text-2xl font-semibold text-white mb-6">{messages.support.faqTitle}</h2>
          <div className="space-y-4">
            {messages.support.faqs.map((faq) => (
              <details
                key={faq.question}
                className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 group open:bg-neutral-900/90"
              >
                <summary className="font-medium text-white cursor-pointer select-none list-none flex justify-between items-center">
                  <span>{faq.question}</span>
                  <span className="ml-2 text-neutral-400 group-open:rotate-180 transition-transform">▼</span>
                </summary>
                <p className="mt-4 text-neutral-300 leading-relaxed border-t border-neutral-800 pt-4">{faq.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="bg-indigo-950/40 border border-indigo-800/60 rounded-xl p-8 text-center">
          <h2 className="text-xl font-semibold text-white mb-2">{messages.support.contactTitle}</h2>
          <p className="text-neutral-300 mb-4 max-w-xl mx-auto">{messages.support.contactBody}</p>
          <a
            href={`mailto:${messages.support.contactEmail}`}
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
          >
            {messages.support.contactEmail}
          </a>
        </section>
      </div>
    </div>
  );
}
