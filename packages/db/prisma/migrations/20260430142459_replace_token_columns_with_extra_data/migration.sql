/*
  Warnings:

  - You are about to drop the column `cache_creation_input_tokens` on the `request_logs` table. All the data in the column will be lost.
  - You are about to drop the column `cache_read_input_tokens` on the `request_logs` table. All the data in the column will be lost.
  - You are about to drop the column `cost_microcents` on the `request_logs` table. All the data in the column will be lost.
  - You are about to drop the column `input_tokens` on the `request_logs` table. All the data in the column will be lost.
  - You are about to drop the column `model` on the `request_logs` table. All the data in the column will be lost.
  - You are about to drop the column `output_tokens` on the `request_logs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "request_logs" DROP COLUMN "cache_creation_input_tokens",
DROP COLUMN "cache_read_input_tokens",
DROP COLUMN "cost_microcents",
DROP COLUMN "input_tokens",
DROP COLUMN "model",
DROP COLUMN "output_tokens",
ADD COLUMN     "extra_data" JSONB;
