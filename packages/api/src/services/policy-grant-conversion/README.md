# policy-grant-conversion — the step-5 selective flip (TEMPORARY)

The one-shot boot pass of `plans/project-attach-model.md` step 5: it
materializes every all-mode agent's effective credential pool as `source:
"grant"` policy-rule stacks (the step-2 compiler's exact shapes, via
`grants-compile`), folds the project's pre-attach rules into per-tool
tri-states, deletes the folded/unmappable remainder (network + behavioral rules
— the census-recorded loosening), resets Block project defaults to allow, and —
only after verifying the published generation — flips agents to
`secretMode="selective"`.

Runs on every web boot from the OSS policy-migrate seam only, after the OSS
legacy pass (whose freshly minted equipment rows it normalizes in the same
boot). The EE seam (`apps/web/src/ee/policy-migrate.ts`) stopped calling it on
2026-07-29 — the cloud fleet was fully converted (census: 0 all-mode) and a
cloud boot was walking every project just to conclude "nothing to do"; on
cloud, `migrate-import` converts its own project inline, with no boot retry
behind it. Idempotency is per agent (`secretMode === "all"`), so on OSS
nothing is ever skipped forever: a failed project is retried on the next boot,
and the fast path makes every boot after the first a cheap no-op.

The partner secret tier is deliberately absent from the materialized grants:
rules cannot name partner secrets, and the gateway injects that tier
mode-independently (the step-5 gateway change in `connect.rs`).

## When to delete this directory

Once every environment that upgrades through this release — cloud, onprem
images still in support, and the OSS grace window — reports zero all-mode
agents (`SELECT count(*) FROM agents WHERE secret_mode <> 'selective'` = 0)
and a full boot logs `0 converted, N skipped, 0 failed`:

1. Delete `packages/api/src/services/policy-grant-conversion/` (this
   directory, tests included).
2. Remove the `runGrantConversion()` call + import from
   `apps/web/src/lib/policy-migrate.ts` (the OSS seam).
3. ~~The EE seam~~ — already done (2026-07-29): `apps/web/src/ee/policy-migrate.ts`
   is a no-op again; only its doc comment's pointer here needs deleting.
4. Remove the post-import `convertProject` call from
   `packages/api/src/ee/routes/migrate-import.ts`.
5. Remove the `agents.secret_mode` schema `///` doc-comment's pointer to this
   directory (`packages/db/prisma/schema.prisma`) — the column itself retires
   separately in step 8.

Nothing outside this list calls into the directory — worth re-proving with a
grep for `policy-grant-conversion` before deleting.
