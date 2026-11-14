# Remote worker contract

Status: implemented, independent review pending; no live rollout performed.

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
- Disabled HP is an example only; K2 is the nv-dev account on physical VPS2.
- Optional preview loopback bind is validated and tested.

Verification: original offline suite plus transport/claim/recovery/capacity/security regression tests. Independent review before any rollout. Tests cannot substitute for an actual authenticated remote smoke test.

Risks: network interruption, filesystem ownership, disk exhaustion, incomplete result transfer. Fail closed when ownership or outcome is uncertain. No merging, deployment, SSH provisioning or live worker starts in this PR.

## Configuration and provisioning

`workers` is optional. Without it, execution remains local as before. When supplied, list order is preference: put **os first**, VPS2 as fallback. Each entry has an id, physical `host`, shared `hostSlots`, per-account `slots`, container `cpus`, free-memory/disk thresholds, and a private absolute `root`. VPS2 and K2 are separate accounts on physical host `vps2`, so both use the same hostSlots ceiling. Disabled workers still retain any previously claimed jobs. `maxParallel` remains the global limit.

Remote entries require `ssh`, optional absolute `identityFile`, and `authFile`. Provision known host keys explicitly; the runner never accepts unknown keys. The SSH principal needs Python3 and Docker. Create root with mode0700, owned by that principal. Auth file must be an ordinary mode0600 file owned by the principal, containing exactly one of `CLAUDE_CODE_OAUTH_TOKEN=...` or `ANTHROPIC_API_KEY=...`. No automatic copying of cached account credentials. GitHub auth is sent only over encrypted stdin for that job.

The runner checks the exact image ID (including the project-specific image) before dispatch. Missing or changed images are transferred with a bounded streaming Docker save/load over SSH, then checked again; unchanged images are reused. Initial transfer may take up to30minutes and temporarily blocks the single polling loop, like the existing image build. No job claim is created until transfer/preflight succeeds. Example remote entries are disabled until provisioned; HP needs separate capacity/auth verification. Start with one global slot and Nuova Vita's measured memory requirement, not speculative parallelism. Configure minimum free memory above the full container limit plus host reserve.

Jobs use independent directories per worker and phase. The original `scenarios.md` contract is transferred for acceptance only; build receives no scenario mount. Only bounded ordinary result files are retrieved, never a remote repository/archive. Log files are read as bounded tails (500KB Claude output, 200KB stderr), matching the original runner. Structured results/scenarios have explicit size limits and must be ordinary files.

Claims in `dataDir/worker-claims` persist across coordinator restart. They store the exact worker identity/configuration and job nonce before dispatch. SSH failure, ambiguous start, or missing container keeps the claim occupied; do not remove it until the assigned host has been inspected and its job stopped. That conservative recovery prevents duplicate writers. Remote container removal follows result retrieval and coordinator evidence recording; only its owned job directory is removed. A small owner-bound completion receipt makes cleanup resumable even after container removal; it retains the bounded result and is replaced at the next phase. An ambiguous start with no confirmed container still requires manual reconciliation. No broad worktree/cache prune is performed.

For tunnel-only previews set `preview.bind` to `127.0.0.1` (or `::1`) and `preview.host` to the tunnel-facing address. Password protection remains. This affects Caddy listener binding, not just the generated link. A domain is rejected in tunnel mode so automatic HTTPS cannot create public listeners.

Verification command: `node --test runner/main.test.ts runner/workers.test.ts`.

Example optional workers (adapt paths and provision credentials first; omitted from the original installation defaults):

```json
{
  "workers": [
    {
      "id": "os",
      "host": "os",
      "hostSlots": 1,
      "cpus": 4,
      "ssh": "os@100.118.14.72",
      "identityFile": "/etc/software-factory/worker_ed25519",
      "root": "/mnt/data/factory-worker",
      "authFile": "/mnt/data/factory-worker-auth.env",
      "slots": 1,
      "minFreeMemoryMiB": 8192,
      "minFreeDiskMiB": 20480,
      "enabled": false
    },
    {
      "id": "vps2",
      "host": "vps2",
      "hostSlots": 1,
      "cpus": 2,
      "root": "/var/lib/software-factory",
      "slots": 1,
      "minFreeMemoryMiB": 8192,
      "minFreeDiskMiB": 10240
    },
    {
      "id": "k2",
      "host": "vps2",
      "hostSlots": 1,
      "cpus": 2,
      "ssh": "nv-dev@100.89.219.74",
      "identityFile": "/etc/software-factory/worker_ed25519",
      "root": "/home/nv-dev/factory-worker",
      "authFile": "/home/nv-dev/factory-worker-auth.env",
      "slots": 1,
      "minFreeMemoryMiB": 8192,
      "minFreeDiskMiB": 10240,
      "enabled": false
    },
    {
      "id": "hp",
      "host": "hp",
      "hostSlots": 1,
      "cpus": 1,
      "ssh": "os@100.113.211.87",
      "identityFile": "/etc/software-factory/worker_ed25519",
      "root": "/mnt/projects/factory-worker",
      "authFile": "/mnt/projects/factory-worker-auth.env",
      "slots": 1,
      "minFreeMemoryMiB": 8192,
      "minFreeDiskMiB": 20480,
      "enabled": false
    }
  ]
}
```

Image transfer exports the immutable ID, compresses with gzip, verifies both process exits and the resulting remote ID, and tags only afterward. Capacity takes both the job filesystem and DockerRootDir into account, including a second disk check immediately before transfer. Each worker records only image IDs it has provisioned. Replacing such a tag attempts to remove its previous owned ID without force; images with any remaining tags/digests are explicitly retained before deletion; existing containers remain protected by Docker and are retained for a later attempt. No global prune occurs.

Offline verification: **34/34 tests passed** (original19 plus transport, scenario isolation, strict SSH, persisted claims/contact loss, resumable cleanup, bounded log tails, image identity/owned cleanup, separate Docker-volume capacity, and loopback-only preview). Actual transport smoke is a separate required rollout gate; it does not establish a Claude product run.
