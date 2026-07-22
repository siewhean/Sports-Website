const mode = process.env.MATCHDAY_PHASE2_DATA_MODE;

if (mode === "demo" && process.env.MATCHDAY_ALLOW_DEMO_FIXTURES !== "1") {
  throw new Error("Demo fixture mode requires MATCHDAY_ALLOW_DEMO_FIXTURES=1");
}

if (mode === "demo" && process.env.APP_ENV !== "local" && process.env.APP_ENV !== "test") {
  throw new Error("Demo fixtures are restricted to local and test environments");
}
