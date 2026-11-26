-- AlterTable
ALTER TABLE "skill_files" ADD COLUMN     "data" BYTEA,
ADD COLUMN     "executable" BOOLEAN NOT NULL DEFAULT false;
