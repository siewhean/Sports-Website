# Archived workflows

GitHub only runs files in `.github/workflows/`. These workflows belong to gates that are closed; they were moved out
so they cannot be triggered, and so no job in this public repository can run on a self-hosted runner.

| File                               | Why archived                                                                                                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gate-c-external-closure.yml`      | Gate C is closed. Ran controlled-staging jobs on the `gate-c-staging` self-hosted runner. Target branch `integration/gate-c-final` is gone.                                                                                          |
| `gate-d-staging-qualification.yml` | Gate D is closed. Its `workflow_run` trigger from `CI` executed on a self-hosted runner for any successful CI run on the targeted branch, which is unsafe on a public repository. Target branch `phase-7/release-hardening` is gone. |
| `phase-6-smtp-certification.yml`   | Phase 6 is closed. Target branch `phase-6/commercial-operations` is gone. The script it ran (`scripts/run-phase-6-smtp-certification.mjs`) is still in the repository.                                                               |

Rules for restoring one:

- Never run self-hosted runners for `pull_request`, `pull_request_target` or `workflow_run` events on this public
  repository. Gate any self-hosted job behind `workflow_dispatch` on a protected environment with required reviewers.
- Update the `branches:` filters first; the branches named above no longer exist.
