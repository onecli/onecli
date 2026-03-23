-- CreateTable
CREATE TABLE "resend_bad_emails" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resend_bad_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resend_webhooks" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "email_subject" TEXT,
    "email_from" TEXT,
    "email_to" TEXT,
    "event_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resend_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resend_bad_emails_email_idx" ON "resend_bad_emails"("email");
