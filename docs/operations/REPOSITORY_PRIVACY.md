# Repository Privacy & GitHub Actions Minute Budget Runbook (Not Yet Executed)

**Status:** Not Yet Executed / Pending Owner Execution  
**Date:** 15 October 2026  
**Track:** R7.5 (Repository privacy and CI budget optimization)  
**Applies to:** GitHub repository visibility, GitHub Actions CI workflows, runner minute quotas

---

## 1. Overview & Objectives

Deliverable R7.5 and Checkpoint **CP7 Item 4** require transitioning the Matchday codebase repository to **private** visibility while maintaining continuous integration rigor and keeping runner minutes within the private repository monthly quota.

> [!WARNING]
> **Execution Status: Not Yet Executed.**  
> The repository `siewhean/Sports-Website` is currently **public**. Visibility cutover to private must be initiated by the repository owner.

### Checkpoint CP7 Item 4 Criteria:

> _"Repository private; required checks still run on every PR."_

---

## 2. Transition Procedure

### 2.1 Pre-Transition Verification

Before toggling repository visibility to private:

1. **Secrets Audit:** Run automated secrets scan (`pnpm test:secrets` or `.github/workflows/ci.yml` `secrets` job) to confirm no unencrypted production credentials or API keys exist in git history.
2. **GHCR Container Registry Permissions:** Ensure GitHub Packages container images (`ghcr.io/siewhean/matchday-*`) retain authenticated pull access for the OCI production deployment agent via dedicated read-only personal access tokens or deploy keys.
3. **Branch Protection Status:** Verify branch protection rules on `main` preserve required status checks.

### 2.2 Visibility Cutover Command

Execute using GitHub CLI:

```bash
# Transition repository visibility to private
gh repo edit siewhean/Sports-Website --visibility private --accept-visibility-change-consequences
```

Verify transition:

```bash
gh repo view siewhean/Sports-Website --json isPrivate,name,visibility
```

---

## 3. GitHub Actions Minute Budget Analysis

### 3.1 Private Repository Quota

- Public repositories use standard GitHub-hosted runners free of charge; once private, Linux minutes count against the account quota: **GitHub Free 2,000 min/month**, **GitHub Pro 3,000 min/month** (personal account `siewhean`).
- GitHub bills each job separately, rounded up to the next whole minute.

### 3.2 Measured CI Cost per PR Run

Measured on 15 October 2026 from `gh run view <id> --json jobs` (job `completedAt - startedAt`, skipped jobs excluded) for six recent successful `ci.yml` `pull_request` runs:

| Run ID        | Branch                                        | Job minutes (raw) | Billed (per-job ceil) |
| ------------- | --------------------------------------------- | ----------------- | --------------------- |
| `38670431186` | `fix/capacity-cross-tenant-write` (#116)      | 50.5              | 55                    |
| `38641582056` | `feat/scheduler-r3-benchmarks` (#102)         | 52.6              | 57                    |
| `38638515631` | `feat/scheduler-quality-format-suggestions`   | 52.3              | 57                    |
| `38607690293` | `feat/scheduler-quality-format-suggestions`   | 54.1              | 58                    |
| `38608953969` | `feat/r7-commercial-legal-identity-readiness` | 49.0              | 54                    |
| `38647270762` | `dependabot/.../npm-minor-and-patch`          | 48.0              | 53                    |
| **Average**   |                                               | **51.1**          | **55.7**              |

Typical per-job split: `browser-e2e` shards 1/2 and 2/2 ≈ 16–20 min each (≈ 70% of the total), `integration` ≈ 5–7.5 min, `quality-fast` ≈ 3–4 min, `gate-d-real-e2e` ≈ 2.5 min, `tournament-simulation` ≈ 2.5 min (0.3 min when path-filtered out), `secrets`/`changes` < 0.5 min.

Note that the docs-only R7 run (`38608953969`) still cost 54 billed minutes: only `tournament-simulation` is path-filtered today; `browser-e2e` and `integration` run on every PR.

### 3.3 Conclusion Against the Quota

- One PR run ≈ **56 billed minutes**. Free (2,000) covers **≈ 35 PR runs/month**; Pro (3,000) covers **≈ 53 PR runs/month**, before `push` runs on `main` and the other workflows (`dependency-audit`, `docker-build-check`, `security-assurance`).
- Actual activity 15 Sep – 15 Oct 2026: **250 `pull_request` runs and 43 `push` runs** of `ci.yml` alone, i.e. roughly **16,000 billed minutes/month** at the measured rate — about **8x the Free quota and 5x the Pro quota**.
- **Going private with the current CI and cadence is not viable on Free or Pro** without either paid overage (Linux minutes are billed per minute beyond the quota) or the mitigations below.

### 3.4 Mitigation Options (owner decision required; none applied yet)

1. **Path filters for heavy suites:** extend the existing `changes` job so `browser-e2e` and `integration` skip docs-only and non-runtime changes, keeping the required checks reporting success via lightweight wrapper jobs (as `tournament-simulation` already does). Saves ≈ 45 min per docs PR.
2. **Nightly heavy suites:** run the full browser E2E matrix nightly / on merge to `main`, with a reduced smoke subset on PRs. Reduces per-PR cost to roughly 15–20 min but delays detection of browser regressions to the nightly run.
3. **Self-hosted runner:** register a runner (e.g. on spare OCI Ampere A1 capacity, separate from the production VM) for the heavy jobs; self-hosted minutes are not billed. Requires runner hardening, since a private repository's PRs then execute on owned infrastructure.
4. **Reduce re-runs:** batch pushes per PR and avoid `update-branch` churn; each push re-runs the full ~56-minute pipeline.

Changes to `.github/workflows/ci.yml` are out of scope for R7 and must be made in a dedicated CI PR.

---

## 4. Required Status Checks Enforcement

Under private repository branch protection, the following required checks remain strictly enforced for all pull requests:

- `secrets`
- `quality-fast`
- `integration`
- `gate-d-real-e2e`
- `browser-e2e (shard 1/2)` and `browser-e2e (shard 2/2)`
- `tournament-simulation`

`tournament-simulation` reports an explicit success even when path-filtered, so required checks do not hang; any future path filter on other required jobs must preserve that behaviour.
