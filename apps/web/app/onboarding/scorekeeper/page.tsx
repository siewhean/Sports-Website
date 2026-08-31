import Link from "next/link";
import { messages } from "@matchday/ui";

export const metadata = {
  title: `${messages.onboarding.title} · ${messages.brand.name}`,
  description: messages.onboarding.subtitle,
};

export default function ScorekeeperOnboardingPage() {
  const steps = [
    { title: messages.onboarding.step1Title, body: messages.onboarding.step1Body },
    { title: messages.onboarding.step2Title, body: messages.onboarding.step2Body },
    { title: messages.onboarding.step3Title, body: messages.onboarding.step3Body },
    { title: messages.onboarding.step4Title, body: messages.onboarding.step4Body },
  ];

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        <header className="mb-10 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">{messages.onboarding.title}</h1>
          <p className="mt-3 text-lg text-neutral-400">{messages.onboarding.subtitle}</p>
        </header>

        <div className="space-y-6">
          {steps.map((step) => (
            <section key={step.title} className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-white mb-2">{step.title}</h2>
              <p className="text-neutral-300 leading-relaxed">{step.body}</p>
            </section>
          ))}
        </div>

        <div className="mt-10 text-center">
          <Link
            href="/score"
            className="inline-flex items-center justify-center px-6 py-3 border border-transparent text-base font-medium rounded-lg text-white bg-indigo-600 hover:bg-indigo-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transition-colors"
          >
            {messages.onboarding.ctaStartScoring}
          </Link>
        </div>
      </div>
    </div>
  );
}
