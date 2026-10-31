-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "sandbox_cpu_millicores_override" INTEGER,
ADD COLUMN     "sandbox_home_gib_override" INTEGER,
ADD COLUMN     "sandbox_memory_mib_override" INTEGER;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "sandbox_cpu_millicores_override" INTEGER,
ADD COLUMN     "sandbox_home_gib_override" INTEGER,
ADD COLUMN     "sandbox_memory_mib_override" INTEGER;

-- AlterTable
ALTER TABLE "sandboxes" ADD COLUMN     "applied_cpu_millicores" INTEGER,
ADD COLUMN     "applied_memory_mib" INTEGER,
ADD COLUMN     "applied_resource_profile_id" TEXT,
ADD COLUMN     "observed_home_bytes" BIGINT,
ADD COLUMN     "resource_observed_at" TIMESTAMP(3);
