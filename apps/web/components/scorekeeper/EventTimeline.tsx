import { ArrowUUpLeft, ClipboardText, Target } from "@phosphor-icons/react";
import { translate as t } from "@matchday/ui";
import type { ScoreEvent } from "./types";
import styles from "../ScorekeeperPrototype.module.css";
import { cssModuleClasses as cx } from "../prototype/cssModuleClasses";

function syncLabel(event: ScoreEvent) {
  if (event.resolution === "discarded") return t("prototype.4b9915385915");
  if (event.resolution === "converted") return t("prototype.ed24efdaf029");
  if (event.sync === "pending") return t("prototype.e45ceb73ca49");
  if (event.sync === "conflict") return t("prototype.3d68c1a96f89");
  return t("prototype.d87cdf8aa304");
}

type EventTimelineProps = { events: readonly ScoreEvent[]; generation: number };

export function EventTimeline({ events, generation }: EventTimelineProps) {
  return (
    <section className={cx(styles, "scorekeeper-history")} aria-labelledby="scorekeeper-history-title">
      <div className={cx(styles, "scorekeeper-section-heading")}>
        <div>
          <p className={cx(styles, "scorekeeper-kicker")}>{t("prototype.888c2074ffa7")}</p>
          <h2 id="scorekeeper-history-title">{t("prototype.e291776d5e08")}</h2>
        </div>
        <span className={cx(styles, "scorekeeper-generation")}>
          {t("prototype.96c0727e4b12")} {generation}
        </span>
      </div>
      {events.length === 0 ? (
        <div className={cx(styles, "scorekeeper-empty-state")}>
          <ClipboardText size={26} aria-hidden="true" />
          <p>{t("prototype.768c72b6d13f")}</p>
        </div>
      ) : (
        <ol
          className={cx(styles, "scorekeeper-event-list")}
          role="list"
          aria-labelledby="scorekeeper-history-title"
          data-testid="scorekeeper-event-list"
          aria-live="polite"
        >
          {[...events].reverse().map((event) => (
            <li
              key={event.id}
              className={cx(styles, "scorekeeper-event", event.kind === "reversal" && "scorekeeper-event--reversal")}
              role="listitem"
              data-event-sync={event.sync}
              data-event-sequence={event.sequence}
            >
              <div className={cx(styles, "scorekeeper-event-main")}>
                {event.kind === "reversal" ? (
                  <ArrowUUpLeft size={20} aria-hidden="true" />
                ) : (
                  <Target size={20} aria-hidden="true" />
                )}
                <div>
                  <strong>{event.label}</strong>
                  {event.reason ? (
                    <span>
                      {t("prototype.3425d1086921")} {event.reason}
                    </span>
                  ) : null}
                </div>
                <time>{event.occurredAt}</time>
              </div>
              <div className={cx(styles, "scorekeeper-event-meta")}>
                <code>{event.id.slice(0, 8)}</code>
                <span>
                  {t("prototype.4f5260d71c7e")} {event.sequence}
                </span>
                <span>
                  {t("prototype.87346eb28235")} {event.generation}
                </span>
                <span>{syncLabel(event)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
