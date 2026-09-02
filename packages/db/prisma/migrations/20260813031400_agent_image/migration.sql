-- The agent's avatar: raster bytes inline (attachments precedent), the mime
-- for the serving Content-Type, and the unguessable public-serving key
-- (rotated on every image change) that fences Slack's unauthenticated fetch.
ALTER TABLE "agents"
  ADD COLUMN "image_data" BYTEA,
  ADD COLUMN "image_mime" TEXT,
  ADD COLUMN "image_key" TEXT;
