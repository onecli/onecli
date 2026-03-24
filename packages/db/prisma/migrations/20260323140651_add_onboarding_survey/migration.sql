-- CreateTable
CREATE TABLE "onboarding_surveys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "use_case" TEXT,
    "discovery" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_surveys_user_id_key" ON "onboarding_surveys"("user_id");

-- AddForeignKey
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
