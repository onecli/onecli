import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which attachment blob store `ensureEditionDefaults()` installs, on the real
 * seam, across the (edition × entitlement × bucket) matrix. The rule: the
 * S3 arm needs BOTH the entitlement and a configured bucket; anything else is
 * the free inline-Postgres arm. Cloud is always entitled, so on cloud the
 * bucket alone flips it; on self-host the bucket is inert without
 * ENTERPRISE_ENABLED ("flag off ⇒ no EE behavior").
 */

const SAVED = {
  EDITION: process.env.EDITION,
  NEXT_PUBLIC_EDITION: process.env.NEXT_PUBLIC_EDITION,
  ENTERPRISE_ENABLED: process.env.ENTERPRISE_ENABLED,
  ATTACHMENTS_S3_BUCKET: process.env.ATTACHMENTS_S3_BUCKET,
};

const restore = (name: keyof typeof SAVED) => {
  const value = SAVED[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const loadWith = async (env: {
  edition: "cloud" | "onprem";
  enterprise?: "true" | "";
  bucket?: string;
}) => {
  vi.resetModules();
  process.env.EDITION = env.edition === "cloud" ? "cloud" : "";
  process.env.NEXT_PUBLIC_EDITION = process.env.EDITION;
  process.env.ENTERPRISE_ENABLED = env.enterprise ?? "";
  process.env.ATTACHMENTS_S3_BUCKET = env.bucket ?? "";
  const providers = await import("./attachment-store");
  const defaults = await import("../edition-defaults");
  const pg = await import("../services/attachments/pg-blob-store");
  const s3 = await import("../ee/attachments/s3-blob-store");
  defaults.ensureEditionDefaults();
  return { store: providers.getAttachmentStore(), pg, s3 };
};

afterEach(() => {
  for (const name of Object.keys(SAVED) as (keyof typeof SAVED)[]) {
    restore(name);
  }
  vi.resetModules();
});

describe("attachment blob store selection", () => {
  it("cloud + bucket → the S3 arm (cloud is always entitled)", async () => {
    const { store, s3 } = await loadWith({
      edition: "cloud",
      bucket: "onecli-attachments-dev-1",
    });
    expect(store).toBe(s3.s3AttachmentBlobStore);
  });

  it("cloud without a bucket → Postgres (config presence is the signal)", async () => {
    const { store, pg } = await loadWith({ edition: "cloud" });
    expect(store).toBe(pg.pgAttachmentBlobStore);
  });

  it("licensed self-host + bucket → the S3 arm", async () => {
    const { store, s3 } = await loadWith({
      edition: "onprem",
      enterprise: "true",
      bucket: "my-bucket",
    });
    expect(store).toBe(s3.s3AttachmentBlobStore);
  });

  it("UNLICENSED self-host + bucket → Postgres: the env alone never flips EE behavior", async () => {
    const { store, pg } = await loadWith({
      edition: "onprem",
      bucket: "my-bucket",
    });
    expect(store).toBe(pg.pgAttachmentBlobStore);
  });

  it("self-host, nothing set → Postgres (the default every self-hoster runs)", async () => {
    const { store, pg } = await loadWith({ edition: "onprem" });
    expect(store).toBe(pg.pgAttachmentBlobStore);
  });
});
