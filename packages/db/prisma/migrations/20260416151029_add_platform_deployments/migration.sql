-- CreateTable
CREATE TABLE "platform_deployments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "vm_name" TEXT NOT NULL,
    "vm_url" TEXT NOT NULL,
    "proxy_token" TEXT,
    "image_tag" TEXT,
    "status" TEXT NOT NULL DEFAULT 'provisioning',
    "name" TEXT NOT NULL DEFAULT 'Andy',
    "channels" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_deployments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_deployments_vm_name_key" ON "platform_deployments"("vm_name");

-- CreateIndex
CREATE INDEX "platform_deployments_account_id_idx" ON "platform_deployments"("account_id");

-- AddForeignKey
ALTER TABLE "platform_deployments" ADD CONSTRAINT "platform_deployments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
