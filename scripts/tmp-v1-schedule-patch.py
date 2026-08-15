from pathlib import Path

runtime_test = Path("apps/api/tests/integration/phase-4-runtime.test.ts")
text = runtime_test.read_text()
old = '''    expect(workspace.generation.capacity_revision).toBeTypeOf("number");
    expect(workspace.matches).toEqual([]);'''
new = '''    expect(workspace.generation.capacity_revision).toBeTypeOf("number");
    expect(workspace.generation.constraints.maximum_matches_per_day).toEqual({
      mode: "preferred",
      value: { matches: 4 },
      weight: 4,
    });
    expect(workspace.matches).toEqual([]);'''
if text.count(old) != 1:
    raise SystemExit(f"Expected one schedule-workspace assertion anchor, found {text.count(old)}")
runtime_test.write_text(text.replace(old, new))

schedule = Path("apps/web/components/phase4/schedule/ScheduleWorkspace.tsx")
text = schedule.read_text()
old = ''': progress === "creating"
          ? phase4ScheduleCopy.v1Creating
          : jobStatusTitle(job)}'''
new = ''': progress === "creating"
          ? phase4ScheduleCopy.v1Creating
          : job.status === "failed"
            ? jobStatusMessage(job)
            : jobStatusTitle(job)}'''
if text.count(old) != 1:
    raise SystemExit(f"Expected one simple schedule status anchor, found {text.count(old)}")
text = text.replace(old, new)
old = '''function jobStatusMessage(job: ScheduleJob): string {
  return `${jobStatusTitle(job)}. ${job.currentBest ? phase4ScheduleCopy.bestAvailable : phase4ScheduleCopy.selectedUnchanged}`;
}'''
new = '''function jobStatusMessage(job: ScheduleJob): string {
  const outcome = `${jobStatusTitle(job)}. ${job.currentBest ? phase4ScheduleCopy.bestAvailable : phase4ScheduleCopy.selectedUnchanged}`;
  if (job.status !== "failed") return outcome;
  const failureReference = job.failureClass ? `${job.failureClass} · ${job.id}` : job.id;
  return `${outcome} ${phase4ScheduleCopy.status}: ${failureReference}.`;
}'''
if text.count(old) != 1:
    raise SystemExit(f"Expected one job status message function, found {text.count(old)}")
schedule.write_text(text.replace(old, new))
