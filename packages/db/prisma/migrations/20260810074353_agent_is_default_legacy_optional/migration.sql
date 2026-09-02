-- AlterTable
ALTER TABLE "agents" ALTER COLUMN "is_default" DROP NOT NULL,
ALTER COLUMN "is_default" DROP DEFAULT;
