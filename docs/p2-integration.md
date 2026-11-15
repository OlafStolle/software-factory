# Existing P2 fixes: bounded integration contract

Tracker: https://github.com/OlafStolle/Nuova-Vita/issues/1417. Reuse the existing SM implementation bb22a5e62e0131c368b68214491d6a8193a6d41f from fix/p2-slots-cleanup; its checkout remains untouched. Integrate on current original Factory main7d50e93, preserving account-aware scheduling and quota recovery.

Scope: runner/main.ts, runner/main.test.ts and this document. Count local improvement containers in physical-host slots in both launch orders. Preserve improvement requests until the host is free. A repeated remote cleanup acknowledgement loss must not duplicate the already finalized result, metrics or cost; owner-bound durable finalization marker.

No product implementation, no parent-issue dispatch, no second queue, no credentials, no session-resume feature in this PR. Original phases/board unchanged. Test both start orders including local and remote product occupancy, repeat cleanup failures and owner isolation, plus all existing tests. Independent review before merge/live update. Existing P3 window before finalization marker remains explicitly outside this bounded ACK-loss repair; do not claim universal exactly-once GitHub transactions.
