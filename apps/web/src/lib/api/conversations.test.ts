import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptPage } from "./types";

/**
 * `allEvents` is the reader's history load, and the only function in this
 * module with logic rather than a URL: it walks the cursor to the end. That
 * walk is where a transcript silently loses its tail, so it gets covered even
 * though the rest of the client is thin enough not to need it.
 */

const apiGet = vi.fn();
const apiPut = vi.fn();
vi.mock("./client", () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: vi.fn(),
  apiPut: (...args: unknown[]) => apiPut(...args),
}));

const { allEvents, ensureDirect, events } = await import("./conversations");

const page = (seqs: number[], hasMore: boolean): TranscriptPage => ({
  events: seqs.map((seq) => ({
    seq,
    turnId: "t1",
    type: "text" as const,
    payload: {},
  })),
  nextSince: seqs.at(-1) ?? 0,
  hasMore,
});

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
});

describe("allEvents", () => {
  it("walks every page to the end, not just the first", () => {
    // The bug this exists for: taking one page and calling it the transcript
    // silently drops everything past 500 events — a single busy turn.
    apiGet
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3, 4], true))
      .mockResolvedValueOnce(page([5], false));

    return allEvents("cv1").then((all) => {
      expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(all.hasMore).toBe(false);
    });
  });

  it("advances the cursor by the page's nextSince", () => {
    apiGet
      .mockResolvedValueOnce(page([1, 2], true))
      .mockResolvedValueOnce(page([3], false));

    return allEvents("cv1").then(() => {
      // First call has no cursor; the second resumes from 2 — a cursor, never
      // an offset, so new events arriving behind it cannot shift the window.
      expect(apiGet.mock.calls[0]?.[0]).not.toContain("since=");
      expect(apiGet.mock.calls[1]?.[0]).toContain("since=2");
    });
  });

  it("stops at the page bound rather than looping forever", () => {
    // A server that always says hasMore must not spin the browser.
    apiGet.mockResolvedValue(page([1], true));

    return allEvents("cv1").then((all) => {
      expect(all.hasMore).toBe(true);
      expect(apiGet.mock.calls.length).toBeLessThanOrEqual(100);
    });
  });

  it("handles an empty transcript", () => {
    apiGet.mockResolvedValueOnce(page([], false));
    return allEvents("cv1").then((all) => {
      expect(all.events).toEqual([]);
    });
  });
});

describe("query building", () => {
  it("omits the query string entirely when nothing is asked for", () => {
    apiGet.mockResolvedValueOnce(page([], false));
    return events("cv1").then(() => {
      expect(apiGet.mock.calls[0]?.[0]).toBe("/v1/conversations/cv1/events");
    });
  });

  it("encodes path ids — a crafted route segment must not re-aim the path", () => {
    // The thread route's id arrives DECODED from useParams: without encoding,
    // "../runners" would URL-normalize onto a different /v1 endpoint under
    // the caller's credentials.
    apiGet.mockResolvedValueOnce(page([], false));
    return events("../runners").then(() => {
      expect(apiGet.mock.calls[0]?.[0]).toBe(
        "/v1/conversations/..%2Frunners/events",
      );
    });
  });
});

describe("ensureDirect", () => {
  it("PUTs the agent's direct-thread door, id encoded", async () => {
    apiPut.mockResolvedValueOnce({ id: "cv-1", direct: true });
    await ensureDirect("../secrets");
    expect(apiPut.mock.calls[0]?.[0]).toBe(
      "/v1/agents/..%2Fsecrets/conversations/direct",
    );
  });
});
