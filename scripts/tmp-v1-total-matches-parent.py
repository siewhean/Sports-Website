from pathlib import Path

replacements = {
    Path("apps/web/tests/v1-exact-capacity-full-placement-real.spec.ts"): (
        '''  const totalMatchesMetric = fullPlacement.locator("div").filter({
    has: fullPlacement.getByText("Total matches", { exact: true }),
  });
  await expect(totalMatchesMetric.locator("dd")).toHaveText("36");''',
        '''  const totalMatchesMetric = fullPlacement.getByText("Total matches", { exact: true }).locator("..");
  await expect(totalMatchesMetric.locator("dd")).toHaveText("36");''',
    ),
    Path("apps/web/tests/v1-competition-real-api.spec.ts"): (
        '''  const totalMatchesMetric = compact.locator("div").filter({
    has: compact.getByText("Total matches", { exact: true }),
  });
  await expect(totalMatchesMetric.locator("dd")).toHaveText("16");''',
        '''  const totalMatchesMetric = compact.getByText("Total matches", { exact: true }).locator("..");
  await expect(totalMatchesMetric.locator("dd")).toHaveText("16");''',
    ),
}

for path, (old, new) in replacements.items():
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"Expected one scoped metric block in {path}, found {text.count(old)}")
    path.write_text(text.replace(old, new))
