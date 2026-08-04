import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scheduleWorkspace = readFileSync(
  new URL("../../components/phase4/schedule/ScheduleWorkspace.tsx", import.meta.url),
  "utf8",
);
const moveFlow = readFileSync(
  new URL("../../components/phase4/schedule/ScheduleMoveFlow.tsx", import.meta.url),
  "utf8",
);
const revisionViews = readFileSync(
  new URL("../../components/phase4/schedule/ScheduleRevisionViews.tsx", import.meta.url),
  "utf8",
);

describe("Phase 4 schedule navigation boundary", () => {
  it.each([
    ["ScheduleWorkspace", scheduleWorkspace],
    ["ScheduleMoveFlow", moveFlow],
  ])("%s does not force a document reload or location navigation", (_name, source) => {
    expect(source).not.toContain("window.location.reload");
    expect(source).not.toContain("window.location.assign");
    expect(source).not.toContain("window.location.replace");
    expect(source).not.toMatch(/window\.location\.href\s*=/);
  });

  it.each([
    ["ScheduleWorkspace", scheduleWorkspace],
    ["ScheduleMoveFlow", moveFlow],
    ["ScheduleRevisionViews", revisionViews],
  ])("%s keeps organiser navigation on the route identifier rather than the internal aggregate ID", (_name, source) => {
    expect(source).toContain("document.competitionRouteId");
    expect(source).not.toMatch(/organiser\/competitions\/\$\{document\.competitionId\}/);
  });
});
