-- AlterTable
ALTER TABLE "secrets" ADD COLUMN     "op_ref" TEXT,
ADD COLUMN     "value_source" TEXT NOT NULL DEFAULT 'inline',
ALTER COLUMN "encrypted_value" DROP NOT NULL;
