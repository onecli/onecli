-- AWS Marketplace billing (Concurrent Agreements integration).
-- The buyer's AWS account id is the customer identity (the legacy
-- CustomerIdentifier is not populated for new listings); each accepted
-- agreement grants a license (LicenseArn) tracked in its own table, and
-- metered usage is attributed to a license.

-- CreateTable
CREATE TABLE "aws_marketplace_subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "customer_aws_account_id" TEXT NOT NULL,
    "product_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "entitled_agents" INTEGER NOT NULL DEFAULT 0,
    "contract_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aws_marketplace_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aws_marketplace_licenses" (
    "id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "license_arn" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "entitled_agents" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "raw_entitlements" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "aws_marketplace_licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "aws_marketplace_metered_records" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "license_arn" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "contract_year_start" TIMESTAMP(3) NOT NULL,
    "quantity_ordinal" INTEGER NOT NULL,
    "usage_timestamp" TIMESTAMP(3) NOT NULL,
    "metering_record_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "aws_marketplace_metered_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "aws_marketplace_subscriptions_organization_id_key" ON "aws_marketplace_subscriptions"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "aws_marketplace_subscriptions_customer_aws_account_id_key" ON "aws_marketplace_subscriptions"("customer_aws_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "aws_marketplace_licenses_license_arn_key" ON "aws_marketplace_licenses"("license_arn");

-- CreateIndex
CREATE UNIQUE INDEX "aws_marketplace_metered_records_organization_id_dimension_c_key" ON "aws_marketplace_metered_records"("organization_id", "dimension", "contract_year_start", "quantity_ordinal");

-- AddForeignKey
ALTER TABLE "aws_marketplace_subscriptions" ADD CONSTRAINT "aws_marketplace_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aws_marketplace_licenses" ADD CONSTRAINT "aws_marketplace_licenses_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "aws_marketplace_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "aws_marketplace_metered_records" ADD CONSTRAINT "aws_marketplace_metered_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
