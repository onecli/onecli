-- The workspace-rename follow-up for `user_provisions`, which the big rename
-- (20260810170000_rename_project_to_workspace) could not cover: the table had
-- been dropped from the schema when that migration was authored, and the drop
-- was reverted before ever being applied. Prod's live table still carries
-- `project_id`, so this is an in-place RENAME (data preserved), hand-tuned from
-- Prisma's drop/add proposal exactly like the big rename itself.
--
-- `project_id` has no foreign key or CHECK constraint — only the unique index
-- needs to follow the column. Final names are byte-identical to what
-- `prisma migrate diff --from-empty --to-schema-datamodel` emits, keeping the
-- CI drift gate green.
--
-- Metadata-only ACCESS EXCLUSIVE renames on a small table: fail fast and retry
-- rather than queueing behind readers (same posture as the big rename).
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "user_provisions" RENAME COLUMN "project_id" TO "workspace_id";

-- RenameIndex
ALTER INDEX "user_provisions_project_id_key" RENAME TO "user_provisions_workspace_id_key";
