# Task contract: preserve the Claude session across quota pauses

Starting point: original runner b778df3; the existing scheduler already retains dirty build work and its claim during account cooldown, then restarts the same container. The entrypoint currently starts a new Claude conversation on that restart.

Scope: `image/entrypoint.sh`, a focused entrypoint regression test, `runner/main.ts` and its existing tests for fail-closed resumption, and this document. A job-local persistent UUID selects the official `--session-id` first-run / `--resume` subsequent-run CLI paths. Sessions remain isolated by container and phase. The existing cooldown/reset/claim scheduler remains the sole coordinator. A failed session recovery must preserve the work and claim instead of starting a second writer or deleting uncommitted work.

Not included: generic host-boot/OOM retries, local desktop chat auto-opening, a supervisor, cross-host dirty-work migration, credentials, product functionality, or another board loop.

Acceptance: simulated quota → cooldown reset → same container/session and preserved dirty work → forward progress; independent phase/new container isolation; invalid/missing resume context fails closed; existing 56 regression tests remain green. Independent review and a harmless container runtime probe precede any image rollout.

Installed Claude CLI help was checked on VPS2 without credentials: `--session-id <uuid>`, `--resume [value]`, and session persistence enabled by default (explicit opt-out `--no-session-persistence`). Exact installed runtime remains the test target.
