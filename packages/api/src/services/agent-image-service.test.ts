import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  agent: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock("@onecli/db", () => ({ db }));

import {
  setAgentImage,
  clearAgentImage,
  getAgentImageByKey,
  agentImageUrlOrNull,
  MAX_AGENT_IMAGE_BYTES,
} from "./agent-image-service";
import { initSelfUrl } from "../providers/self-url";
import { ServiceError } from "./errors";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF = Buffer.from("GIF89a\x00\x00");
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBP"),
]);
/** A script container dressed as an image — the classic stored-XSS payload. */
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`);

describe("setAgentImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initSelfUrl("https://api.example.com");
    db.agent.findFirst.mockResolvedValue({ id: "a1" });
    db.agent.update.mockResolvedValue({});
  });

  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
  ])(
    "accepts %s by magic bytes and rotates the key",
    async (_n, bytes, mime) => {
      const result = await setAgentImage("w1", "a1", bytes);
      const write = db.agent.update.mock.calls[0]?.[0].data;
      expect(write.imageMime).toBe(mime);
      expect(write.imageKey).toMatch(/^[a-f0-9]{32}$/);
      expect(result.imageUrl).toBe(
        `https://api.example.com/v1/agent-images/a1/${write.imageKey}`,
      );
    },
  );

  it("refuses an SVG — a script container, never an avatar", async () => {
    await expect(setAgentImage("w1", "a1", SVG)).rejects.toThrow(
      /PNG, JPEG, WebP, or GIF/,
    );
    expect(db.agent.update).not.toHaveBeenCalled();
  });

  it("verifies by BYTES, not by any client claim — random junk is refused", async () => {
    await expect(
      setAgentImage("w1", "a1", Buffer.from("not an image")),
    ).rejects.toThrow(ServiceError);
  });

  it("caps the size", async () => {
    const huge = Buffer.alloc(MAX_AGENT_IMAGE_BYTES + 1, 0x89);
    await expect(setAgentImage("w1", "a1", huge)).rejects.toThrow(/capped/);
  });

  it("404s an agent outside the caller's workspace", async () => {
    db.agent.findFirst.mockResolvedValue(null);
    await expect(setAgentImage("w1", "aX", PNG)).rejects.toThrow(
      "Agent not found",
    );
  });

  it("fences the lookup at the QUERY — id AND workspaceId together", async () => {
    // The args assertion is the mutation-proof half of the fence test above:
    // a mock returning null passes that one no matter WHAT the where was.
    await setAgentImage("w1", "a1", PNG);
    expect(db.agent.findFirst).toHaveBeenCalledWith({
      where: { id: "a1", workspaceId: "w1" },
      select: { id: true },
    });
  });
});

describe("clearAgentImage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nulls all three columns together — no half-cleared avatar — behind the same workspace fence", async () => {
    db.agent.findFirst.mockResolvedValue({ id: "a1" });
    await clearAgentImage("w1", "a1");
    expect(db.agent.findFirst).toHaveBeenCalledWith({
      where: { id: "a1", workspaceId: "w1" },
      select: { id: true },
    });
    expect(db.agent.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { imageData: null, imageMime: null, imageKey: null },
      select: { id: true },
    });
  });

  it("404s an agent outside the caller's workspace — nothing cleared", async () => {
    db.agent.findFirst.mockResolvedValue(null);
    await expect(clearAgentImage("w1", "aX")).rejects.toThrow(
      "Agent not found",
    );
    expect(db.agent.update).not.toHaveBeenCalled();
  });
});

describe("getAgentImageByKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("serves only on an id+key MATCH", async () => {
    db.agent.findFirst.mockResolvedValue({
      imageData: new Uint8Array(PNG),
      imageMime: "image/png",
    });
    const key = "a".repeat(32);
    const { mime } = await getAgentImageByKey("a1", key);
    expect(mime).toBe("image/png");
    expect(db.agent.findFirst).toHaveBeenCalledWith({
      where: { id: "a1", imageKey: key },
      select: { imageData: true, imageMime: true },
    });
  });

  it("refuses a malformed key BEFORE any query — no oracle, no scan", async () => {
    await expect(getAgentImageByKey("a1", "short")).rejects.toThrow(
      ServiceError,
    );
    expect(db.agent.findFirst).not.toHaveBeenCalled();
  });

  it("404s hint-free when the key is wrong", async () => {
    db.agent.findFirst.mockResolvedValue(null);
    await expect(getAgentImageByKey("a1", "b".repeat(32))).rejects.toThrow(
      "Not found",
    );
  });
});

describe("agentImageUrlOrNull", () => {
  it("null key = no image = null URL", () => {
    expect(agentImageUrlOrNull("a1", null)).toBeNull();
    initSelfUrl("https://api.example.com/");
    expect(agentImageUrlOrNull("a1", "k".repeat(32))).toBe(
      `https://api.example.com/v1/agent-images/a1/${"k".repeat(32)}`,
    );
  });
});
