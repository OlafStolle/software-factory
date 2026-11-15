## Goal
Keep the original GitHub-driven runner productive when one explicitly configured Claude account reaches its quota. No second scheduler, daemon or credential-cache access.

## Scope and contract
- Optional worker account IDs; os and VPS2 can share one quota/cooldown, K2 a separate account, physical host limits unchanged.
- Persist only explicit rejected rate-limit events from the existing Claude stream, using reported reset timestamps and bounded conservative fallback. No speculative usage polling or secret extraction.
- Skip accounts in cooldown and continue other eligible issues when a single launch fails.
- Only stopped jobs with proven clean/pushed work may be automatically requeued to another account. Dirty/unpushed work keeps its original container, claim and workspace; after reset resume that same container without overwriting its Git branch. No cross-host work migration.
- Contact loss/ambiguous start continues to retain claims; no duplicate writers. Original check/build/accept and GitHub statuses remain.

Owned files: runner/main.ts, runner/main.test.ts, runner/workers.ts, runner/workers.test.ts; one small account-state helper and its tests if warranted; image/entrypoint.sh only for preservation of the same existing build branch on restart; docs/account-failover.md.

Tests: shared-account cooldown, reset/restart persistence, rejected versus warning events, no duplicate dispatch on contact loss, dirty/unpushed work preservation, safe restart on same host, blocked/failed issue does not starve later eligible issues. Independent review before merge/rollout. No live configuration changes before evidence.
