"use client";

import { useState } from "react";
import { Pause, Play, Asterisk } from "@phosphor-icons/react";
import { messages } from "@matchday/ui";
import styles from "./SportsBanner.module.css";

export function SportsBanner() {
  const [paused, setPaused] = useState(false);

  return (
    <div className={styles.banner} data-paused={paused}>
      <div className={styles.viewport}>
        <div className={styles.track}>
          {[false, true].map((duplicate) => (
            <ul
              key={String(duplicate)}
              className={styles.sports}
              aria-label={duplicate ? undefined : messages.home.marqueeLabel}
              aria-hidden={duplicate || undefined}
            >
              {messages.home.marqueeItems.map((sport) => (
                <li key={sport}>
                  <Asterisk aria-hidden="true" />
                  <span>{sport}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
      <button
        type="button"
        className={styles.control}
        aria-label={paused ? messages.home.resumeSportsBanner : messages.home.pauseSportsBanner}
        onClick={() => setPaused((current) => !current)}
      >
        {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
      </button>
    </div>
  );
}
