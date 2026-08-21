import "server-only";

type DemoFixtureEnvironment = Readonly<Record<string, string | undefined>>;

export function demoFixturesEnabled(source: DemoFixtureEnvironment = process.env): boolean {
  if (source.MATCHDAY_PHASE2_DATA_MODE !== "demo") return false;
  if (source.MATCHDAY_ALLOW_DEMO_FIXTURES !== "1") {
    throw new Error("Demo fixture mode requires MATCHDAY_ALLOW_DEMO_FIXTURES=1");
  }
  if (source.APP_ENV !== "local" && source.APP_ENV !== "test") {
    throw new Error("Demo fixtures are restricted to local and test environments");
  }
  return true;
}
