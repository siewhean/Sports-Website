"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { messages } from "@matchday/ui";
import { ActionLink } from "@/components/foundation/Primitives";
import { SiteFooter, SiteHeader } from "@/components/foundation/SiteChrome";

gsap.registerPlugin(ScrollTrigger, useGSAP);

export function MarketingHome() {
  const scope = useRef<HTMLElement>(null);
  const [activeCapability, setActiveCapability] = useState(0);

  useGSAP(
    () => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const words = gsap.utils.toArray<HTMLElement>("[data-reveal-word]");
      gsap.set(words, { opacity: 0.42 });
      gsap.to(words, {
        opacity: 1,
        stagger: 0.08,
        scrollTrigger: {
          trigger: "[data-reveal-sentence]",
          start: "top 76%",
          end: "bottom 42%",
          scrub: 0.5,
        },
      });

      gsap.fromTo(
        "[data-scale-visual]",
        { scale: 0.82, opacity: 0.45 },
        {
          scale: 1,
          opacity: 1,
          scrollTrigger: {
            trigger: "[data-scale-visual]",
            start: "top 88%",
            end: "center 52%",
            scrub: 0.5,
          },
        },
      );
      gsap.to("[data-scale-visual]", {
        opacity: 0.24,
        scrollTrigger: {
          trigger: "[data-scale-visual]",
          start: "center 22%",
          end: "bottom top",
          scrub: 0.5,
        },
      });

      gsap.to("[data-marquee-track]", {
        transform: "translate3d(-50%, 0, 0)",
        duration: 24,
        ease: "none",
        repeat: -1,
      });
    },
    { scope },
  );

  const revealWords = messages.home.desireTitle.split(" ");

  return (
    <main ref={scope} className="marketing-home" id="main-content">
      <a className="skip-link" href="#marketing-content">
        {messages.navigation.skip}
      </a>
      <section className="marketing-hero" aria-labelledby="marketing-title">
        <SiteHeader inverse />
        <div className="marketing-hero__copy" id="marketing-content">
          <p className="marketing-eyebrow">{messages.home.eyebrow}</p>
          <h1 id="marketing-title">
            {messages.home.titleStart}{" "}
            <span className="marketing-inline-image" aria-hidden="true">
              <Image src="/images/venue-arc.svg" alt="" width={190} height={82} priority />
            </span>{" "}
            {messages.home.titleEnd}
          </h1>
          <p className="marketing-hero__summary">{messages.home.summary}</p>
          <div className="marketing-actions">
            <ActionLink href="/organiser" tone="signal">
              {messages.home.primaryAction}
            </ActionLink>
          </div>
        </div>
        <div className="marketing-hero__visual" aria-hidden="true">
          <Image src="/images/venue-arc.svg" alt="" fill priority sizes="(max-width: 767px) 100vw, 62vw" />
        </div>
        <p className="marketing-hero__proof">{messages.home.proof}</p>
      </section>

      <section className="marketing-interest" aria-labelledby="interest-title">
        <div className="marketing-interest__intro">
          <h2 id="interest-title">{messages.home.interestTitle}</h2>
          <p>{messages.home.interestBody}</p>
        </div>
        <div className="marketing-accordions" aria-label={messages.home.accordionLabel}>
          {messages.home.capabilities.map((capability, index) => (
            <button
              type="button"
              key={capability.title}
              className={activeCapability === index ? "is-active" : ""}
              onClick={() => setActiveCapability(index)}
              onPointerEnter={() => setActiveCapability(index)}
              aria-expanded={activeCapability === index}
            >
              <strong>{capability.title}</strong>
              <span>{capability.body}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="marketing-desire" aria-labelledby="desire-title">
        <div className="marketing-desire__copy">
          <h2 id="desire-title" data-reveal-sentence>
            {revealWords.map((word, index) => (
              <span data-reveal-word key={`${word}-${index}`}>
                {word}{" "}
              </span>
            ))}
          </h2>
          <p>{messages.home.desireBody}</p>
        </div>
        <figure className="marketing-desire__visual" data-scale-visual>
          <Image
            src="/images/venue-arc.svg"
            alt={messages.home.visualAlt}
            fill
            sizes="(max-width: 767px) 100vw, 54vw"
          />
        </figure>
      </section>

      <section className="marketing-marquee" aria-label={messages.home.marqueeLabel}>
        <div data-marquee-track>
          {[...messages.home.marqueeItems, ...messages.home.marqueeItems].map((sport, index) => (
            <span key={`${sport}-${index}`}>{sport}</span>
          ))}
        </div>
      </section>

      <section className="marketing-action" aria-labelledby="action-title">
        <h2 id="action-title">{messages.home.finalTitle}</h2>
        <p>{messages.home.finalBody}</p>
        <ActionLink href="/organiser" tone="signal">
          {messages.home.finalAction}
        </ActionLink>
      </section>
      <SiteFooter inverse />
    </main>
  );
}
