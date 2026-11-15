## Goal
Keep the original GitHub-driven runner productive when one explicitly configured Claude account reaches its quota. No second scheduler, daemon or credential-cache access.

## Scope and contract
- Optional worker account IDs; os and VPS2 can share one quota/cooldown, K2 a separate account, physical host limits unchanged.
- Persist only explicit rejected rate-limit events from the existing Claude stream, using reported reset timestamps and bounded conservative fallback. No speculative usage polling or secret extraction.
- Skip accounts in cooldown and continue other eligible issues when a single launch fails.
- Only stopped jobs with proven clean/pushed work may be automatically requeued to another account. Dirty/unpushed work keeps its original container, claim and workspace; after reset resume that same container without overwriting its Git branch. No cross-host work migration.
- Contact loss/ambiguous start continues to retain claims; no duplicate writers. Original check/build/accept and GitHub statuses remain.

Owned files: runner/main.ts, runner/main.test.ts, runner/workers.ts, runner/workers.test.ts; one small account-state helper and its tests if warranted; image/Dockerfile for the safe-resume capability label; image/entrypoint.sh only for preservation of the same existing build branch on restart; docs/account-failover.md.

Tests: shared-account cooldown, reset/restart persistence, rejected versus warning events, no duplicate dispatch on contact loss, dirty/unpushed work preservation, safe restart on same host, blocked/failed issue does not starve later eligible issues. Independent review before merge/rollout. No live configuration changes before evidence.


## Operation and rollout
Configure `account: "main"` on os and VPS2, `account: "k2"` on the separately authenticated K2 worker. Without an account field, the existing worker ID is used. No credentials enter cooldown state or GitHub comments. K2 remains disabled until its own container authentication probe passes; HP remains disabled pending verified access/capacity.

Only a rejected structured Claude stream event triggers cooldown; warnings, overage and arbitrary text do not. The SDK event/reset schema is documented in [Anthropic's SDK types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py). Reported resets are capped at seven days; missing resets retry after fifteen minutes. Corrupt state fails closed. A paused claim still occupies its original physical-host/global slot; other free hosts/accounts can progress.

Deploy runner AND rebuilt base/project images. The new image carries `sf.resume-safe=1`; old images cannot automatically resume retained dirty work. Do not roll back the runner while quota-paused work exists: retain containers/claims and resolve that work first. Clean work can restart elsewhere after the checkpoint proves no dirty/untracked files or unpublished commits. An unverifiable checkpoint stays retained for operator attention. No cross-host checkout migration or auth-cache copying.

Validation: 46 offline regressions, including actual Bash entrypoint against a real Git remote and actual Python host handler against a deterministic Docker boundary. These do not claim a live quota event or paid-account failover test. Live configuration, rebuilt images, and a harmless transport smoke remain rollout gates. GitHub `factory:done` retains its original meaning (merged); separate DEV-QA stays in its existing issue checklist.
