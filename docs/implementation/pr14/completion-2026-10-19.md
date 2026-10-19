# PR14 completion checkpoint — 19.10.2026

User requested completion, tests, push and merge readiness on 19.10.2026.
This supersedes older instructions to retain Draft after successful acceptance.
No merge is authorized or performed.

## Source state

- main: `3dba9ff5cc19e53c0f6d764b5f41f5880ff92e52`.
- Existing PR #14: `feature/pr14-foundation-standards`, previously `2e1055a`.
- Continued audit work: `8a4398f` and `4a0e3ae`, previously only on
  `feature/pr14-audit-fixes`. Preserved as ancestors of this completion.
- Local continuation: `feature/pr14-completion`.

## Implemented follow-up

- Shared, transport-neutral command-intent controller used by the frontend
  adapter and real Socket.IO integration tests; no frontend import in the
  server build. Final acknowledgements consume tokens; pending/malformed
  acknowledgements retain them. Delayed acknowledgements cannot erase newer IDs.
- A failed Geo config snapshot enters durable `ERROR_RECOVERY`; no fallback
  timer or scoring. Host, Player and Viewer restore the error on resync/reload.
  Host can end the failed game even before the first question exists.
- `game:end` receipts store a successful response and replay it. Previously
  the state ended successfully but the new receipt path reported rejection.
- Lobby ready actions wait for successful subscription and serialize pending
  updates. Rejection leaves a fresh user retry possible.
- Migration verification now deploys all three PR14 migrations, including
  `beforeStateRevision`, and exercises a receipted action after legacy rejoin.
- WID E2E sets its documented 90-second timeout through `test.setTimeout`;
  `timeout` in test metadata was not applying the intended limit.

## Checkpoint status

Typecheck, lint and both builds pass. Web tests: 76/76. Full server regression
is rerun after extending the migration fixture (its old hardcoded count of 7
was corrected to derive from the staged migration list).

Local browser execution is unavailable: Chromium exits before loading any
application page because this runtime denies its process-singleton Unix socket
(`socket() failed: Operation not permitted`). The complete Playwright suite
must therefore be verified in GitHub Actions at the pushed PR head; it is not
represented as a local pass. No tests are skipped to work around this limit.

## Next actions

Run the final server suite, push the existing PR head by fast-forward, inspect
both GitHub CI and E2E, correct any actual failures, update canonical handoff,
acceptance, verification and PR text, then mark Ready only with green checks.
Planplatz PR14 (TEAM-ROOM), full editor/voice/display, new games and the full
V1 audit remain separate follow-up packages.
