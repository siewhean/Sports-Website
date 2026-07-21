import { translate as t } from "@matchday/ui";
import type { ScorekeeperTeam } from "../types";

type TeamFixture = {
  name: string;
  scoreAriaLabel: (score: number) => string;
  goalButtonLabel: string;
};

type SummaryRow = {
  label: string;
  value: string;
};

export type ScorekeeperFixture = {
  accessCode: string;
  initialEventTime: string;
  initialGeneration: number;
  matchTitle: string;
  confirmationLabel: string;
  summary: readonly SummaryRow[];
  teams: Record<ScorekeeperTeam, TeamFixture>;
};

export const scorekeeperFixture = {
  accessCode: "POLO-12",
  initialEventTime: "07:32",
  initialGeneration: 7,
  matchTitle: t("prototype.03091f4fe1af"),
  confirmationLabel: t("prototype.ecdf3836d8cf"),
  summary: [
    { label: t("prototype.449303332f88"), value: t("prototype.1357967f45d5") },
    { label: t("prototype.cd9558acfc38"), value: t("prototype.71d6e22a6a68") },
    { label: t("prototype.2ab25f10948b"), value: t("prototype.d455163ecaec") },
    { label: t("prototype.639a40e82b9a"), value: t("prototype.23f50c06e3e7") },
  ],
  teams: {
    blue: {
      name: t("prototype.2b4e73ebbf39"),
      scoreAriaLabel: (score) => t("prototype.54e34e7a97f9", { score }),
      goalButtonLabel: t("prototype.02070bc85a77"),
    },
    gold: {
      name: t("prototype.6f4c82dde169"),
      scoreAriaLabel: (score) => t("prototype.eb43c97b82a0", { score }),
      goalButtonLabel: t("prototype.ea5c998c326d"),
    },
  },
} as const satisfies ScorekeeperFixture;
