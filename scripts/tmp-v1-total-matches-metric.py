from pathlib import Path

replacements = {
    Path("apps/web/tests/v1-exact-capacity-full-placement-real.spec.ts"): (
        '''  await expect(fullPlacement.getByText("Total matches", { exact: true })).toBeVisible();
  await expect(fullPlacement.getByText("36", { exact: true })).toBeVisible();''',
        '''  const totalMatchesMetric = fullPlacement.locator("div").filter({
    has: fullPlacement.getByText("Total matches", { exact: true }),
  });
  await expect(totalMatchesMetric.locator("dd")).toHaveText("36");''',
    ),
    Path("apps/web/tests/v1-competition-real-api.spec.ts"): (
        '''  await expect(compact.getByText("Total matches", { exact: true })).toBeVisible();
  await expect(compact.getByText("16", { exact: true })).toBeVisible();''',
        '''  const totalMatchesMetric = compact.locator("div").filter({
    has: compact.getByText("Total matches", { exact: true }),
  });
  await expect(totalMatchesMetric.locator("dd")).toHaveText("16");''',
    ),
}

for path, (old, new) in replacements.items():
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"Expected one metric assertion block in {path}, found {text.count(old)}")
    path.write_text(text.replace(old, new))
