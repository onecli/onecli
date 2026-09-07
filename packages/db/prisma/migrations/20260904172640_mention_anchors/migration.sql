-- CreateTable
CREATE TABLE "mention_anchors" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "external_user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mention_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mention_anchors_conversation_id_name_key" ON "mention_anchors"("conversation_id", "name");

-- AddForeignKey
ALTER TABLE "mention_anchors" ADD CONSTRAINT "mention_anchors_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
