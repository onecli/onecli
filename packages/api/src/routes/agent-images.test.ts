import { beforeEach, describe, expect, it, vi } from "vitest";

// The PUBLIC avatar-serving door's HTTP contract: sessionless by design
// (Slack fetches `icon_url` with no credentials), a locked serving posture
// (sniffed Content-Type + nosniff + bounded cache, NO attachment
// disposition — the image must render inline), and hint-free 404s. The
// key/format laws live in agent-image-service.test.ts.

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_EDITION = "onprem";
});

const services = vi.hoisted(() => ({
  getAgentImageByKey: vi.fn(),
}));

vi.mock("@onecli/db", () => ({ Prisma: {}, db: {} }));

vi.mock("../services/agent-image-service", () => ({
  getAgentImageByKey: services.getAgentImageByKey,
}));

const { createApiApp } = await import("../app");
const { ServiceError } = await import("../services/errors");

const app = createApiApp({ getSession: async () => null });

const KEY = "a".repeat(32);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  services.getAgentImageByKey.mockReset();
});

describe("GET /v1/agent-images/:agentId/:imageKey", () => {
  it("serves SESSIONLESS with the locked posture: sniffed type, nosniff, bounded cache, inline", async () => {
    services.getAgentImageByKey.mockResolvedValue({
      bytes: PNG,
      mime: "image/png",
    });
    // Deliberately NO auth header of any kind — this pins the public mount:
    // wrapping this route in a session check breaks every Slack icon fetch.
    const res = await app.request(`/v1/agent-images/a1/${KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    // Inline by design — an avatar must RENDER, unlike the attachments door.
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect(services.getAgentImageByKey).toHaveBeenCalledWith("a1", KEY);
  });

  it("404s hint-free on a wrong id/key", async () => {
    services.getAgentImageByKey.mockRejectedValue(
      new ServiceError("NOT_FOUND", "Not found"),
    );
    const res = await app.request(`/v1/agent-images/a1/${"b".repeat(32)}`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("Not found");
  });
});
