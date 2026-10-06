import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadOAuthConnection = vi.hoisted(() => vi.fn());
const validAccessToken = vi.hoisted(() => vi.fn());
vi.mock("./oauth-connection-token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-connection-token")>()),
  loadOAuthConnection,
  validAccessToken,
}));

const SCOPE = { organizationId: "org", workspaceId: "ws" };

import {
  listGoogleDriveFolders,
  resolveGoogleDriveFolderNames,
} from "./google-drive-folder-service";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("google-drive-folder-service", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadOAuthConnection.mockResolvedValue({ conn: { id: "c1" }, creds: {} });
    validAccessToken.mockResolvedValue("tok");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** A fake Drive routed by URL: folder listings (mimeType = folder),
   * child-count calls (no mimeType filter), and the shared-drive list. */
  const fakeDrive = (opts: {
    folders: Record<string, { id: string; name: string }[]>;
    pages?: Record<string, string>;
    children?: Record<string, { mimeType: string }[] | "error">;
    drives?: { id: string; name: string }[];
  }) =>
    fetchMock.mockImplementation(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith("/drives")) {
        return json(200, { drives: opts.drives ?? [] });
      }
      const q = url.searchParams.get("q") ?? "";
      const parent = /^'([^']+)' in parents/.exec(q)?.[1] ?? "";
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        const pageToken = url.searchParams.get("pageToken");
        const key = pageToken ? `${parent}#${pageToken}` : parent;
        return json(200, {
          files: opts.folders[key] ?? [],
          nextPageToken: pageToken ? undefined : opts.pages?.[parent],
        });
      }
      const kids = opts.children?.[parent] ?? [];
      if (kids === "error") return json(500, {});
      return json(200, { files: kids });
    });

  it("lists My Drive's top-level folders plus shared drives, with counts", async () => {
    fakeDrive({
      folders: { root: [{ id: "f1", name: "Clients" }] },
      children: {
        f1: [
          { mimeType: "application/vnd.google-apps.folder" },
          { mimeType: "application/pdf" },
          { mimeType: "text/plain" },
        ],
        "0SD": "error",
      },
      drives: [{ id: "0SD", name: "Team" }],
    });
    const out = await listGoogleDriveFolders(SCOPE, "c1", undefined);
    expect(out).toEqual([
      {
        id: "f1",
        name: "Clients",
        kind: "folder",
        subfolderCount: 1,
        fileCount: 2,
        countCapped: false,
      },
      // A failed count degrades to unknown, never fails the listing.
      {
        id: "0SD",
        name: "Team",
        kind: "sharedDrive",
        subfolderCount: null,
        fileCount: null,
        countCapped: false,
      },
    ]);
    // Scoped to the org's own connection of this provider.
    expect(loadOAuthConnection).toHaveBeenCalledWith(
      SCOPE,
      "c1",
      "google-drive",
    );
    const listUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(listUrl.searchParams.get("q")).toBe(
      "'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer tok" },
      signal: expect.any(AbortSignal),
    });
  });

  it("lists a subfolder's children, following pagination, without drives", async () => {
    fakeDrive({
      folders: {
        parent_1: [{ id: "a", name: "A" }],
        "parent_1#p2": [{ id: "b", name: "B" }],
      },
      pages: { parent_1: "p2" },
    });
    const out = await listGoogleDriveFolders(SCOPE, "c1", "parent_1");
    expect(out.map((f) => [f.id, f.subfolderCount, f.fileCount])).toEqual([
      ["a", 0, 0],
      ["b", 0, 0],
    ]);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes("pageToken=p2"))).toBe(true);
    expect(urls.some((u) => u.includes("/drives"))).toBe(false);
  });

  it("refuses a parent id that could break out of the Drive query", async () => {
    await expect(
      listGoogleDriveFolders(SCOPE, "c1", "x' or trashed = false or 'y"),
    ).rejects.toThrow("Invalid folder id");
    expect(loadOAuthConnection).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops entries with ids the gateway could never verify", async () => {
    fakeDrive({
      folders: {
        root: [
          { id: "ok", name: "Ok" },
          { id: "bad/id", name: "Bad" },
        ],
      },
    });
    const out = await listGoogleDriveFolders(SCOPE, "c1", undefined);
    expect(out.map((f) => f.id)).toEqual(["ok"]);
  });

  it("fails when no token can be obtained", async () => {
    validAccessToken.mockResolvedValue(null);
    await expect(
      listGoogleDriveFolders(SCOPE, "c1", undefined),
    ).rejects.toThrow("No valid Google Drive access token");
  });

  it("resolves names, labeling a shared drive's root with the drive's name", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/files/f1")) return json(200, { name: "Clients" });
      // A shared drive's root folder shares the drive's ID; its own file name
      // is not what the picker listed it as.
      if (url.includes("/files/0SD"))
        return json(200, { name: "Drive", driveId: "0SD" });
      if (url.includes("/files/")) return json(404, {});
      if (url.includes("/drives/0SD")) return json(200, { name: "Team" });
      if (url.includes("/drives/0HIDDEN")) return json(200, { name: "Ops" });
      return json(404, {});
    });
    await expect(
      resolveGoogleDriveFolderNames(SCOPE, "c1", [
        "f1",
        "0SD",
        "0HIDDEN",
        "gone",
        "f1",
      ]),
    ).resolves.toEqual({
      f1: "Clients",
      "0SD": "Team",
      // Not visible as a file, but visible as a shared drive.
      "0HIDDEN": "Ops",
      gone: null,
    });
    await expect(
      resolveGoogleDriveFolderNames(SCOPE, "c1", ["../x"]),
    ).rejects.toThrow();
  });

  it("bounds every Drive call in time, and a failed one degrades to unknown", async () => {
    fetchMock.mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(
      resolveGoogleDriveFolderNames(SCOPE, "c1", ["f1"]),
    ).resolves.toEqual({ f1: null });
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });
});
