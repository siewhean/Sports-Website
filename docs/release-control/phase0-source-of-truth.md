# Phase 0 source of truth — observed 11 October 2026

WRITE_GATE=PASS_FOR_ISOLATED_SOURCE_WORK_ONLY

Main is e8e0761c259f9857d9c459785fda0bfb01d50797, tree c37f04e8816c4977d339e0b220a0b46f41e7ab86. Fetched origin matches local main. Primary has two pre-existing untracked production-oriented files; they are excluded and preserved. No concurrent tracked edits found.

PR67 open/behind (9a9577faa58079c2ef97217260e7dfc214297df9), PR68 open/conflicting (9c248fe1b63bcda6e10dfadb8d6528e8793ef1d3), PR69 open/behind (8e093b662d63b4222b885b18e232447470cc8b58), PR70 draft/integration-only/conflicting (2b89d74de0da457ab57281b6fb33156edc884efe). No original PR is authorised to merge main. Safe new branch reconciliation preserves shared history.

Merges since66: PR71 readiness,72 hardening,82 ARM64,83 US-West/disclosure,84 scheduler CI yield,88 maintenance/backup drill,92 SMTP Reply-To,93 serving-Caddy validation. Current PR deltas must be assessed against all these merged changes.

Hosted CI38117670424 exact main passed secrets,quality-fast,integration,both browser shards,GateD and all five image jobs. Optional visual baseline skipped. verified-contracts-and-deployment artifact11693888093 archive digest sha256:8155c5a5728725f68488166e7a1909c490b28a0149bacc8348eab496b0e1d84e. Five registry indexes, ARM64 manifests, revision labels and SLSA run/source bindings verified read-only; see five-image-provenance.json. This proves published builds, not deployment. New candidates require fresh exact-head evidence.

Vercel configured domains v1-preview.poladex.shop and sports-website-web.vercel.app independently resolve via alias API to READY dpl_CmCo2cPCgGmsw2XnZACp2RbGrocL at8f38feb0bb2c91a552033f013148568cae1b944b. Latest main e8e0761 deployment dpl_2FfmbwqwJEjHUYf7CLiAZd8RnyDD canceled/ignored-build. See vercel-routing.json. Public Matchday API metadata HTTP200 reports8f38feb0 and production; readiness HTTP200 healthy DB/Redis/queue at observation time. OCI host/container/web/worker versions and recovery unknown; no SSH performed.

Canonical ADR0005, execution roadmap, backup operations, launch checklist and original archived GateF specification reviewed. Machine-verifiable OPS001–018 remain mandatory. Human-only checks remain WAIVED_NOT_EXECUTED; formal legal approval DEFERRED_TO_FIRST_COMMERCIAL_RELEASE. Exact40SHA must bind future hosted CI/deploy/receipts. Synthetic source simulation is not production certification.

Source gaps: PR67 migration static improvements useful but backup audit must require schedule; timer must reject empty/malformed ACTIVE_SHA; drill failure/cleanup must not become PASS. Binding WAL15min, daily30days,weekly90days,monthlyrestore,crossregion absent from nightly14/8/quarterly architecture. Actual RPO/RTO unknown. PR88 restore claim unverified because no retained independent receipt found; not disproved.

PR68 useful audit/control changes must preserve current Sentry exports/hostname abstraction and default failclosed behavior. Admin feature flag UI exists yet main audit hardcodes absent. Source inventory must not imply provider delivery,90day logs,statuspage,costalert or synthetic probe proof.

PR69 has stale migration count/source references and overstates WAL/log-retention/certification. Legacy Caddy mount must be measured by authorised operator, not assumed; use targeted non-secret inspection and correct env/service-only commands. Legal entity,UEN,address,DPO,forum placeholders need owner facts. Integration PR70 is not a main release path.

Authorised next action: four isolated source branches, scoped fixes/tests/docs, independent integration/QA, hosted candidate certification. No main merge, SSH, production DB access, deployment, DNS/provider mutation, paid operation or real alert is authorised.

This is a historical Phase0 snapshot, not combined-candidate certification. Traceable sanitized observations are retained in [phase0-evidence.json](phase0-evidence.json). New source candidates require fresh exact-head CI, artifact binding and independent QA. No production mutation or main merge was performed.
