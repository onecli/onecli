import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_OUTBOUND_ATTACHMENT_BYTES,
  MAX_OUTBOUND_ATTACHMENT_BYTES_PER_CONVERSATION_DAY,
  MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
} from "@onecli/agent-protocol";
import { proofDatabaseUrl } from "../testing/pg-proof.js";

/**
 * The outbound attachment door (`send_file`, Tier 3), against a real
 * Postgres: the two-fact fence with its PLANTED negative controls (a foreign
 * runner, a foreign agent's turn, a finished turn), every cap, the checksum
 * belt, and the happy path — a `bound`, `outbound`, agent-sourced row whose
 * bytes come back through the same blob seam the web download reads, plus
 * the audit row under the turn's author.
 */

const PROOF_URL = proofDatabaseUrl();

type Db = typeof import("@onecli/db").db;
type PlatformTools = typeof import("./platform-tool-service");
type AttachmentService = typeof import("./attachment-service");
type AdapterService = typeof import("./channels/channel-adapter-service");
type AttachmentStore = typeof import("../providers/attachment-store");
type PgStore = typeof import("./attachments/pg-blob-store");

let db: Db;
let platformTools: PlatformTools;
let attachmentService: AttachmentService;
let adapterService: AdapterService;
let attachmentStore: AttachmentStore;
let pgStore: PgStore;

const P = "oba-";
const ORG = `${P}org`;
const WORKSPACE = `${P}proj`;
const RUNNER = `${P}runner`;
const FOREIGN_RUNNER = `${P}runner-x`;
const USER = `${P}user`;

beforeAll(async () => {
  if (!PROOF_URL) return;
  process.env.DATABASE_URL = PROOF_URL;
  process.env.EDITION = "onprem";
  process.env.NEXT_PUBLIC_EDITION = "onprem";
  ({ db } = await import("@onecli/db"));
  platformTools = await import("./platform-tool-service");
  attachmentService = await import("./attachment-service");
  adapterService = await import("./channels/channel-adapter-service");
  attachmentStore = await import("../providers/attachment-store");
  pgStore = await import("./attachments/pg-blob-store");
  attachmentStore.initAttachmentStore(pgStore.pgAttachmentBlobStore);
  await resetAll();
  await db.organization.create({ data: { id: ORG, name: ORG, slug: ORG } });
  await db.workspace.create({
    data: { id: WORKSPACE, name: "Outbound Workspace", organizationId: ORG },
  });
});

afterAll(async () => {
  if (!PROOF_URL) return;
  await resetAll();
  attachmentStore.initAttachmentStore(null);
});

const resetAll = async () => {
  await db.channelThreadLink.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.agentChannel.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.channelAdapter.deleteMany({ where: { name: { startsWith: P } } });
  await db.channelIntegration.deleteMany({ where: { organizationId: ORG } });
  await db.conversationAttachment.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.workspace.deleteMany({ where: { id: { startsWith: P } } });
  await db.organization.deleteMany({ where: { id: { startsWith: P } } });
};

beforeEach(async () => {
  if (!PROOF_URL) return;
  await db.channelThreadLink.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.agentChannel.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.channelAdapter.deleteMany({ where: { name: { startsWith: P } } });
  await db.conversationAttachment.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.turn.deleteMany({
    where: { conversation: { agent: { identifier: { startsWith: P } } } },
  });
  await db.conversation.deleteMany({
    where: { agent: { identifier: { startsWith: P } } },
  });
  await db.sandbox.deleteMany({ where: { id: { startsWith: P } } });
  await db.agent.deleteMany({ where: { identifier: { startsWith: P } } });
  await db.runner.deleteMany({ where: { id: { startsWith: P } } });
  await db.auditLog.deleteMany({ where: { userId: USER } });
  await db.user.deleteMany({ where: { id: { startsWith: P } } });
  await db.user.create({
    data: {
      id: USER,
      email: `${P}user@example.com`,
      name: "Outbound User",
      externalAuthId: `${P}auth`,
    },
  });
  await db.runner.create({
    data: { id: RUNNER, name: "runner", token: `rnr_${P}` },
  });
  await db.runner.create({
    data: { id: FOREIGN_RUNNER, name: "runner x", token: `rnr_${P}x` },
  });
});

/** A hosted agent with its sandbox, one conversation, one turn in a given
 * status — the whole fence chain the door walks. */
const seed = async (suffix: string, turnStatus = "running") => {
  const agent = await db.agent.create({
    data: {
      workspaceId: WORKSPACE,
      name: `agent ${suffix}`,
      identifier: `${P}${suffix}`,
      accessToken: `aoc_${P}${suffix}`,
      kind: "hosted",
      harness: "fake",
      sandbox: { create: { id: `${P}sb-${suffix}`, runnerId: RUNNER } },
    },
    select: { id: true },
  });
  const conversation = await db.conversation.create({
    data: { agentId: agent.id, source: "web", title: "t" },
    select: { id: true },
  });
  const turn = await db.turn.create({
    data: {
      conversationId: conversation.id,
      message: "make me a file",
      status: turnStatus,
      userId: USER,
    },
    select: { id: true },
  });
  return {
    agentId: agent.id,
    sandboxId: `${P}sb-${suffix}`,
    conversationId: conversation.id,
    turnId: turn.id,
  };
};

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The stored id of a successful upload — the test fails honestly otherwise. */
const idOf = (result: { ok: boolean; attachmentId?: string }): string => {
  expect(result.ok).toBe(true);
  expect(result.attachmentId).toBeTruthy();
  return result.attachmentId ?? "";
};

const upload = (
  runnerId: string,
  ids: { sandboxId: string; conversationId: string; turnId: string },
  bytes: Buffer,
  overrides: Partial<{ name: string; sha256: string; caption: string }> = {},
) =>
  platformTools.executeAttachmentUpload(
    runnerId,
    {
      sandboxId: ids.sandboxId,
      conversationId: ids.conversationId,
      turnId: ids.turnId,
      name: overrides.name ?? "report.pdf",
      sha256: overrides.sha256 ?? sha(bytes),
      ...(overrides.caption !== undefined && { caption: overrides.caption }),
    },
    "application/pdf",
    bytes,
  );

describe.skipIf(!PROOF_URL)("outbound attachments (send_file door)", () => {
  it("stores a bound, outbound, agent-sourced row whose bytes read back through the blob seam, and audits it under the turn's author", async () => {
    const ids = await seed("a");
    const bytes = Buffer.from("%PDF-1.4 hello");
    const result = await upload(RUNNER, ids, bytes, { caption: "Here it is" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: result.attachmentId },
    });
    expect(row).toMatchObject({
      conversationId: ids.conversationId,
      turnId: ids.turnId,
      userId: null,
      source: "agent",
      direction: "outbound",
      status: "bound",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: sha(bytes),
      caption: "Here it is",
    });
    const stored = await attachmentStore
      .getAttachmentStore()
      .get({ id: row.id, storageRef: row.storageRef });
    expect(Buffer.compare(stored, bytes)).toBe(0);

    const audit = await db.auditLog.findFirst({
      where: { userId: USER, service: "attachment", action: "create" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({
      attachmentId: row.id,
      turnId: ids.turnId,
      direction: "outbound",
      viaAgent: "true",
    });
    // Metadata, never content.
    expect(JSON.stringify(audit?.metadata)).not.toContain("hello");
  });

  it("FENCE: a foreign runner presenting the sandbox id is refused, hint-free, storing nothing", async () => {
    const ids = await seed("b");
    const result = await upload(FOREIGN_RUNNER, ids, Buffer.from("x"));
    expect(result).toEqual({
      ok: false,
      error: "This file cannot be sent right now.",
    });
    expect(await db.conversationAttachment.count()).toBe(0);
  });

  it("FENCE: a turn belonging to ANOTHER agent's conversation is refused with the same words", async () => {
    const mine = await seed("c");
    const other = await seed("d");
    const result = await upload(
      RUNNER,
      { ...mine, conversationId: other.conversationId, turnId: other.turnId },
      Buffer.from("x"),
    );
    expect(result).toEqual({
      ok: false,
      error: "This file cannot be sent right now.",
    });
    expect(await db.conversationAttachment.count()).toBe(0);
  });

  it("FENCE: a turn that already finished cannot receive a late file", async () => {
    const ids = await seed("e", "done");
    const result = await upload(RUNNER, ids, Buffer.from("x"));
    expect(result.ok).toBe(false);
    expect(await db.conversationAttachment.count()).toBe(0);
  });

  it("CHECKSUM: bytes that do not hash to the declared sha256 are refused", async () => {
    const ids = await seed("f");
    const result = await upload(RUNNER, ids, Buffer.from("real"), {
      sha256: sha(Buffer.from("claimed")),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/checksum/);
    expect(await db.conversationAttachment.count()).toBe(0);
  });

  it("CAP: the per-turn file count", async () => {
    const ids = await seed("g");
    for (let i = 0; i < MAX_OUTBOUND_ATTACHMENTS_PER_TURN; i += 1) {
      const bytes = Buffer.from(`file ${i}`);
      expect((await upload(RUNNER, ids, bytes, { name: `f${i}.txt` })).ok).toBe(
        true,
      );
    }
    const over = await upload(RUNNER, ids, Buffer.from("one more"), {
      name: "over.txt",
    });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(/per reply/);
    expect(await db.conversationAttachment.count()).toBe(
      MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
    );
  });

  it("CAP under CONCURRENCY: a turn's files arriving together land exactly the cap — check-then-insert is serialized per conversation", async () => {
    // MUTATION-TESTED: drop the advisory lock in createOutboundAttachment
    // and this lands ~15 rows: every concurrent upload reads the same count.
    const ids = await seed("conc");
    const results = await Promise.all(
      Array.from({ length: MAX_OUTBOUND_ATTACHMENTS_PER_TURN + 5 }, (_, i) =>
        upload(RUNNER, ids, Buffer.from(`f${i}`), { name: `f${i}.txt` }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(
      MAX_OUTBOUND_ATTACHMENTS_PER_TURN,
    );
    expect(results.filter((r) => !r.ok)).toHaveLength(5);
    expect(
      await db.conversationAttachment.count({
        where: { turnId: ids.turnId, direction: "outbound" },
      }),
    ).toBe(MAX_OUTBOUND_ATTACHMENTS_PER_TURN);
  });

  it("CAP: the per-conversation rolling-24h byte budget, counting only OUTBOUND rows", async () => {
    const ids = await seed("h");
    // An inbound row of the same conversation must not count toward it.
    await db.conversationAttachment.create({
      data: {
        conversationId: ids.conversationId,
        turnId: ids.turnId,
        userId: USER,
        source: "web",
        direction: "inbound",
        name: "in.bin",
        mimeType: "application/octet-stream",
        sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES_PER_CONVERSATION_DAY,
        sha256: "0".repeat(64),
        status: "bound",
      },
    });
    // Plant outbound rows summing to just under the budget (metadata only —
    // the cap reads size_bytes, not the blob).
    await db.conversationAttachment.create({
      data: {
        conversationId: ids.conversationId,
        turnId: ids.turnId,
        userId: null,
        source: "agent",
        direction: "outbound",
        name: "big.bin",
        mimeType: "application/octet-stream",
        sizeBytes: MAX_OUTBOUND_ATTACHMENT_BYTES_PER_CONVERSATION_DAY - 10,
        sha256: "1".repeat(64),
        status: "bound",
      },
    });
    const fits = await upload(RUNNER, ids, Buffer.alloc(10, 1), {
      name: "fits.bin",
    });
    expect(fits.ok).toBe(true);
    const over = await upload(RUNNER, ids, Buffer.alloc(1, 1), {
      name: "over.bin",
    });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.error).toMatch(/daily limit/);
  });

  it("CAP: the per-file byte belt holds even if the route's stream cap were bypassed", async () => {
    const ids = await seed("i");
    const result = await upload(
      RUNNER,
      ids,
      Buffer.alloc(MAX_OUTBOUND_ATTACHMENT_BYTES + 1),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/capped/);
  });

  it("sanitizes a hostile file name and normalizes the media type", async () => {
    const ids = await seed("j");
    const bytes = Buffer.from("x");
    const result = await platformTools.executeAttachmentUpload(
      RUNNER,
      {
        sandboxId: ids.sandboxId,
        conversationId: ids.conversationId,
        turnId: ids.turnId,
        name: "../../etc/passwd",
        sha256: sha(bytes),
      },
      "TEXT/Plain; charset=utf-8",
      bytes,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: result.attachmentId },
      select: { name: true, mimeType: true },
    });
    expect(row.name).not.toContain("/");
    expect(row.name).not.toMatch(/^\./);
    expect(row.mimeType).toBe("text/plain");
  });
});

/**
 * THE READ SIDE (WS4b): how a stored outbound file reaches its two surfaces.
 * The adapter's work feed carries the turn's outbound rows (never the
 * person's inbound ones under the answer, never the agent's under the
 * person's name), and the adapter's byte pull is fenced to its ownership
 * slice. The dispatch-time readers stay INBOUND-only, so a re-dispatch
 * never hands the agent its own output back.
 */
describe.skipIf(!PROOF_URL)("outbound attachments: the read side", () => {
  /** A linked Slack presence over `ids.conversationId`, owned by a fresh
   * adapter instance. Returns the owner's adapter id and the link. */
  const linkToAdapter = async (
    suffix: string,
    ids: { agentId: string; conversationId: string },
  ) => {
    const integration = await db.channelIntegration.upsert({
      where: {
        organizationId_provider: { organizationId: ORG, provider: "slack" },
      },
      create: {
        organizationId: ORG,
        provider: "slack",
        externalId: "T-oba",
        name: "Outbound Co",
      },
      update: {},
      select: { id: true },
    });
    const adapter = await db.channelAdapter.create({
      data: {
        token: `cha_${P}${suffix}`,
        name: `${P}adapter-${suffix}`,
        kind: "instance",
      },
      select: { id: true },
    });
    const presence = await db.agentChannel.create({
      data: {
        agentId: ids.agentId,
        integrationId: integration.id,
        provider: "slack",
        externalId: `A-${P}${suffix}`,
        identityRef: "UBOT",
        transport: "socket",
        status: "active",
        ownerAdapterId: adapter.id,
      },
      select: { id: true },
    });
    const link = await db.channelThreadLink.create({
      data: {
        agentChannelId: presence.id,
        conversationId: ids.conversationId,
        externalThreadId: `C-${suffix}:1.1`,
        kind: "group",
      },
      select: { id: true },
    });
    // The mirror floor is strict: the link must predate the turn.
    await db.$executeRaw`UPDATE channel_thread_links SET created_at = now() - interval '10 minutes' WHERE id = ${link.id}`;
    return { adapterId: adapter.id, presenceId: presence.id, linkId: link.id };
  };

  const finish = (turnId: string) =>
    db.turn.update({
      where: { id: turnId },
      data: { status: "done", finishedAt: new Date() },
    });

  /** The person's inbound file on the same turn — the shape the projection
   * must keep on the PERSON's side. */
  const inbound = (
    ids: { conversationId: string; turnId: string },
    name: string,
  ) =>
    db.conversationAttachment.create({
      data: {
        conversationId: ids.conversationId,
        turnId: ids.turnId,
        userId: USER,
        name,
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: sha(Buffer.from("i")),
        status: "bound",
      },
      select: { id: true },
    });

  it("the work feed carries the turn's OUTBOUND files (id, name, type, size, caption) under the answer and keeps inbound names in the person's line", async () => {
    const ids = await seed("r1");
    const { adapterId } = await linkToAdapter("r1", ids);
    await inbound(ids, "brief.txt");
    const a = await upload(RUNNER, ids, Buffer.from("A"), {
      name: "clip.webm",
      caption: "the run",
    });
    const b = await upload(RUNNER, ids, Buffer.from("B"), {
      name: "report.pdf",
    });
    const [aId, bId] = [idOf(a), idOf(b)];
    await finish(ids.turnId);

    const work = await adapterService.getAdapterWork(adapterId);
    const item = work.finished.find((w) => w.turn.id === ids.turnId);
    expect(item).toBeDefined();
    expect(item?.turn.attachments).toEqual([
      {
        id: aId,
        name: "clip.webm",
        // The helper declares application/pdf; the projection carries the
        // STORED type verbatim, it does not re-derive one from the name.
        mimeType: "application/pdf",
        sizeBytes: 1,
        caption: "the run",
      },
      {
        id: bId,
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        caption: null,
      },
    ]);
    // The person's line names THEIR file and none of the agent's.
    expect(item?.turn.message).toContain("📎 brief.txt");
    expect(item?.turn.message).not.toContain("clip.webm");
    expect(item?.turn.message).not.toContain("report.pdf");
  });

  it("a turn without outbound files carries an empty list, not an absent field", async () => {
    const ids = await seed("r2");
    const { adapterId } = await linkToAdapter("r2", ids);
    await finish(ids.turnId);
    const work = await adapterService.getAdapterWork(adapterId);
    const item = work.finished.find((w) => w.turn.id === ids.turnId);
    expect(item?.turn.attachments).toEqual([]);
  });

  it("FENCE: the adapter byte pull serves the owner and refuses everyone else, hint-free", async () => {
    const ids = await seed("r3");
    const { adapterId } = await linkToAdapter("r3", ids);
    const bytes = Buffer.from("the file body");
    const sentId = idOf(await upload(RUNNER, ids, bytes, { name: "out.bin" }));

    const mine = await attachmentService.getAttachmentBytesForAdapter(
      sentId,
      adapterId,
    );
    expect(mine?.name).toBe("out.bin");
    expect(mine?.mimeType).toBe("application/pdf");
    expect(mine && Buffer.compare(mine.bytes, bytes)).toBe(0);

    // Another instance that owns nothing here.
    const stranger = await db.channelAdapter.create({
      data: { token: `cha_${P}stranger`, name: `${P}adapter-stranger` },
      select: { id: true },
    });
    expect(
      await attachmentService.getAttachmentBytesForAdapter(sentId, stranger.id),
    ).toBeNull();
    // An unknown id, and the OWNER asking for an INBOUND row (not its to read).
    expect(
      await attachmentService.getAttachmentBytesForAdapter("nope", adapterId),
    ).toBeNull();
    const theirs = await inbound(ids, "secret-brief.txt");
    expect(
      await attachmentService.getAttachmentBytesForAdapter(
        theirs.id,
        adapterId,
      ),
    ).toBeNull();
  });

  it("FENCE: ownership follows the presence — a conversation with no thread link is unreachable to every adapter", async () => {
    const ids = await seed("r4");
    const sentId = idOf(await upload(RUNNER, ids, Buffer.from("x")));
    const adapter = await db.channelAdapter.create({
      data: { token: `cha_${P}unlinked`, name: `${P}adapter-unlinked` },
      select: { id: true },
    });
    expect(
      await attachmentService.getAttachmentBytesForAdapter(sentId, adapter.id),
    ).toBeNull();
  });

  it("the web META read serves the row under its conversation and 404s under any other (the download page's fence)", async () => {
    const ids = await seed("r6");
    const other = await seed("r6b");
    const sentId = idOf(
      await upload(RUNNER, ids, Buffer.from("m"), {
        name: "clip.webm",
        caption: "the run",
      }),
    );
    const meta = await attachmentService.getAttachmentMeta(
      ids.conversationId,
      sentId,
    );
    expect(meta).toMatchObject({
      id: sentId,
      name: "clip.webm",
      sizeBytes: 1,
      status: "bound",
      direction: "outbound",
      caption: "the run",
    });
    // Same id, a different conversation: absent, not disclosed.
    await expect(
      attachmentService.getAttachmentMeta(other.conversationId, sentId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attachmentService.getAttachmentMeta(ids.conversationId, "nope"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("RETENTION: a bound row past the window loses its bytes and reads expired — download 410, feed excludes it, sweep idempotent", async () => {
    const ids = await seed("ret");
    const { adapterId } = await linkToAdapter("ret", ids);
    const oldId = idOf(
      await upload(RUNNER, ids, Buffer.from("old bytes"), { name: "old.txt" }),
    );
    const freshId = idOf(
      await upload(RUNNER, ids, Buffer.from("new"), { name: "fresh.txt" }),
    );
    // Backdate ONE row past the window (the sweep keys on created_at).
    await db.$executeRaw`UPDATE conversation_attachments SET created_at = now() - interval '31 days' WHERE id = ${oldId}`;
    await finish(ids.turnId);

    expect(await attachmentService.sweepExpiredAttachments()).toBe(1);

    const old = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: oldId },
      select: { status: true, data: true, storageRef: true, name: true },
    });
    // Bytes gone, metadata kept.
    expect(old).toEqual({
      status: "expired",
      data: null,
      storageRef: null,
      name: "old.txt",
    });
    const fresh = await db.conversationAttachment.findUniqueOrThrow({
      where: { id: freshId },
      select: { status: true, data: true },
    });
    expect(fresh.status).toBe("bound");
    expect(fresh.data?.byteLength).toBe(3);

    // The web reads: metadata still names the file (status says expired,
    // the page can say what it no longer has); every byte path is a distinct
    // GONE, never "not found".
    expect(
      await attachmentService.getAttachmentMeta(ids.conversationId, oldId),
    ).toMatchObject({
      name: "old.txt",
      status: "expired",
      conversation: { source: "web", agent: { id: ids.agentId } },
    });
    await expect(
      attachmentService.getAttachmentForDownload(ids.conversationId, oldId),
    ).rejects.toMatchObject({ code: "GONE" });
    await expect(
      attachmentService.getAttachmentDownloadUrl(ids.conversationId, oldId),
    ).rejects.toMatchObject({ code: "GONE" });
    // The adapter pull and the work feed carry only the fresh one.
    expect(
      await attachmentService.getAttachmentBytesForAdapter(oldId, adapterId),
    ).toBeNull();
    const work = await adapterService.getAdapterWork(adapterId);
    const item = work.finished.find((w) => w.turn.id === ids.turnId);
    expect(item?.turn.attachments.map((a) => a.id)).toEqual([freshId]);

    // Idempotent: a second pass finds nothing.
    expect(await attachmentService.sweepExpiredAttachments()).toBe(0);
  });

  it("the dispatch-time readers are INBOUND-only: a re-dispatch never hands the agent its own file back", async () => {
    const ids = await seed("r5");
    await inbound(ids, "brief.txt");
    const sent = await upload(RUNNER, ids, Buffer.from("out"), {
      name: "out.pdf",
    });
    expect(sent.ok).toBe(true);

    const plan = await attachmentService.planTurnAttachments(ids.turnId);
    expect(plan.manifest.map((entry) => entry.name)).toEqual(["brief.txt"]);
    expect(plan.note ?? "").not.toContain("out.pdf");

    // And the title fallback names what the PERSON sent.
    const own = await seed("r5b");
    await upload(RUNNER, own, Buffer.from("o"), { name: "agent-made.pdf" });
    expect(await attachmentService.firstAttachmentName(own.turnId)).toBeNull();
  });

  it("EXTERNAL STORE: the ref put() returns is written to the row, so every reader dispatches to the arm that holds the bytes", async () => {
    // A fake object store standing where S3 does: the seam contract is that
    // put() answers with the row's storageRef and the service RECORDS it.
    // Before this test, nothing did — under the S3 arm every row stayed
    // storageRef null, every reader went to the inline arm, and every
    // download of an object-stored file failed "no stored bytes".
    const objects = new Map<string, Buffer>();
    const external: ReturnType<AttachmentStore["getAttachmentStore"]> = {
      async put(meta, bytes) {
        const key = `fake:${meta.conversationId}/${meta.id}`;
        objects.set(key, Buffer.from(bytes));
        return { storageRef: key };
      },
      async get(ref) {
        if (ref.storageRef === null) throw new Error("inline read on the fake");
        const hit = objects.get(ref.storageRef);
        if (!hit) throw new Error(`fake: no object at ${ref.storageRef}`);
        return hit;
      },
      async presign(ref, file) {
        if (ref.storageRef === null) return null;
        return {
          url: `https://fake.invalid/${ref.storageRef}?name=${encodeURIComponent(file.name)}`,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async expire(refs) {
        for (const ref of refs) {
          if (ref.storageRef !== null) objects.delete(ref.storageRef);
        }
      },
      async delete(refs) {
        for (const ref of refs) {
          if (ref.storageRef !== null) objects.delete(ref.storageRef);
        }
      },
    };
    attachmentStore.initAttachmentStore(external);
    try {
      const ids = await seed("ext");
      const { adapterId } = await linkToAdapter("ext", ids);
      const bytes = Buffer.from("object bytes");
      const id = idOf(await upload(RUNNER, ids, bytes, { name: "obj.pdf" }));

      // The row points at the object, and the inline column stayed empty.
      const row = await db.conversationAttachment.findUniqueOrThrow({
        where: { id },
        select: { storageRef: true, data: true },
      });
      expect(row.storageRef).toBe(`fake:${ids.conversationId}/${id}`);
      expect(row.data).toBeNull();

      // Every reader reaches the bytes THROUGH the ref.
      const web = await attachmentService.getAttachmentForDownload(
        ids.conversationId,
        id,
      );
      expect(web.bytes.equals(bytes)).toBe(true);
      const signed = await attachmentService.getAttachmentDownloadUrl(
        ids.conversationId,
        id,
      );
      expect(signed?.url).toContain(`fake:${ids.conversationId}/${id}`);
      await finish(ids.turnId);
      const adapter = await attachmentService.getAttachmentBytesForAdapter(
        id,
        adapterId,
      );
      expect(adapter?.bytes.equals(bytes)).toBe(true);

      // The INBOUND door (a person's upload) records its ref the same way,
      // bind keeps it, and the runner's dispatch-time pull reads through it.
      const inboundBytes = Buffer.from("the person's brief");
      const pending = await attachmentService.createPendingAttachment({
        conversationId: ids.conversationId,
        userId: USER,
        source: "web",
        name: "brief.txt",
        mimeType: "text/plain",
        bytes: inboundBytes,
      });
      const pendingRow = await db.conversationAttachment.findUniqueOrThrow({
        where: { id: pending.id },
        select: { storageRef: true, data: true },
      });
      expect(pendingRow.storageRef).toBe(
        `fake:${ids.conversationId}/${pending.id}`,
      );
      expect(pendingRow.data).toBeNull();
      const bound = await seed("ext2");
      await db.$transaction((tx) =>
        attachmentService.bindAttachmentsToTurn(tx, {
          conversationId: ids.conversationId,
          turnId: bound.turnId,
          userId: USER,
          attachmentIds: [pending.id],
        }),
      );
      const forRunner = await attachmentService.getAttachmentBytesForRunner(
        pending.id,
        RUNNER,
      );
      expect(forRunner?.bytes.equals(inboundBytes)).toBe(true);

      // Retention takes the objects and clears the refs (both directions).
      await db.$executeRaw`UPDATE conversation_attachments SET created_at = now() - interval '31 days' WHERE id IN (${id}, ${pending.id})`;
      expect(await attachmentService.sweepExpiredAttachments()).toBe(2);
      expect(objects.size).toBe(0);
      const gone = await db.conversationAttachment.findUniqueOrThrow({
        where: { id },
        select: { status: true, storageRef: true },
      });
      expect(gone).toEqual({ status: "expired", storageRef: null });
    } finally {
      attachmentStore.initAttachmentStore(pgStore.pgAttachmentBlobStore);
    }
  });
});
