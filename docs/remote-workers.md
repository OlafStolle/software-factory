# Remote worker contract

Status: implementation pending; no live rollout authorized by this PR.

Goal: keep one original VPS2 runner and its GitHub board, while executing jobs on explicitly configured SSH workers. No second scheduler or registry service.

Scope: runner/main.ts, runner/workers.ts, runner/workers.test.ts, runner/main.test.ts, factory.config.example.json, this document.

Acceptance:
- Missing worker configuration retains original local behavior.
- Explicit host allocation is persisted before dispatch; an unreachable or ambiguous job cannot be assigned elsewhere.
- Capacity checks reserve free RAM/disk and enforce host slot limits.
- SSH verifies known host keys, uses batch authentication and bounded timeouts; no secret in command arguments/logs.
- Remote credentials are a provisioned worker-local env file, never copied from CLI caches.
- Check/accept scenarios stay separate; build receives no scenarios.
- Results are recovered before removal; cleanup targets only this runner's completed job directories and containers.
- Disabled HP is an example only; unknown K2 is not fabricated.
- Optional preview loopback bind is validated and tested.

Verification: original offline suite plus transport/claim/recovery/capacity/security regression tests. Independent review before any rollout. Tests cannot substitute for an actual authenticated remote smoke test.

Risks: network interruption, filesystem ownership, disk exhaustion, incomplete result transfer. Fail closed when ownership or outcome is uncertain. No merging, deployment, SSH provisioning or live worker starts in this PR.
