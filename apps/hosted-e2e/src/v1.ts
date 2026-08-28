/**
 * The `/v1` client a black-box test drives — an `oc_` bearer + the workspace
 * header, exactly what a real API consumer sends. Bounded `waitFor` helpers
 * instead of fixed sleeps: dueness in this system is poll-computed, so the
 * only honest wait is "poll the observable until the predicate holds".
 */

export interface V1Client {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
  put(path: string, body?: unknown): Promise<Response>;
  del(path: string): Promise<Response>;
  json<T>(response: Response): Promise<T>;
}

export const v1Client = (
  origin: string,
  apiKey: string,
  workspaceId: string,
): V1Client => {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "x-workspace-id": workspaceId,
    "content-type": "application/json",
  };
  const call = (path: string, method: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
  return {
    get: (path) => call(path, "GET"),
    post: (path, body) => call(path, "POST", body ?? {}),
    put: (path, body) => call(path, "PUT", body ?? {}),
    del: (path) => call(path, "DELETE"),
    json: async <T>(response: Response): Promise<T> => {
      if (!response.ok) {
        throw new Error(
          `${response.url} → ${response.status}: ${await response.text()}`,
        );
      }
      return (await response.json()) as T;
    },
  };
};

export interface TranscriptEvent {
  seq: number;
  turnId: string;
  type: string;
  payload: Record<string, unknown>;
}

interface TranscriptPage {
  events: TranscriptEvent[];
  nextSince: number;
  hasMore: boolean;
}

/** The whole durable transcript, paged to exhaustion. */
export const fetchTranscript = async (
  v1: V1Client,
  conversationId: string,
): Promise<TranscriptEvent[]> => {
  const events: TranscriptEvent[] = [];
  let since = 0;
  for (;;) {
    const page = await v1.json<TranscriptPage>(
      await v1.get(
        `/v1/conversations/${conversationId}/events?since=${since}&limit=500`,
      ),
    );
    events.push(...page.events);
    since = page.nextSince;
    if (!page.hasMore) break;
  }
  return events;
};

/** Flattened transcript text (the fake's text deltas), for assertions. */
export const transcriptText = (events: TranscriptEvent[]): string =>
  events
    .map((event) => {
      const text = event.payload["text"];
      return typeof text === "string" ? text : "";
    })
    .join("");

/** Poll until the predicate holds or the deadline passes — with the LAST
 * observed value attached to the failure, so a timeout is diagnosable. */
export const waitFor = async <T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `timed out waiting for ${label}; last: ${JSON.stringify(last)?.slice(0, 2_000)}`,
  );
};

export interface TurnRow {
  id: string;
  status: string;
  source?: string;
  userId?: string | null;
  message?: string;
  error?: string | null;
  errorCode?: string | null;
}

/**
 * A live tail of the conversation's SSE stream, for asserting that events
 * actually FLOW to an attached consumer (history reads cannot prove that).
 * Deliberately not built on `v1Client` — its 30s request timeout would cut
 * the tail. Frames are parsed off the `event:`/`id:`/`data:` lines;
 * keep-alive comments are skipped.
 */
export interface StreamTap {
  frames: { id?: string; event?: string; data: TranscriptEvent }[];
  waitForFrame(
    predicate: (frame: { event?: string; data: TranscriptEvent }) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<void>;
  close(): Promise<void>;
}

export const openStream = async (
  origin: string,
  apiKey: string,
  workspaceId: string,
  conversationId: string,
  opts: { since?: number } = {},
): Promise<StreamTap> => {
  const controller = new AbortController();
  const since = opts.since !== undefined ? `?since=${opts.since}` : "";
  const response = await fetch(
    `${origin}/v1/conversations/${conversationId}/stream${since}`,
    {
      headers: {
        authorization: `Bearer ${apiKey}`,
        "x-workspace-id": workspaceId,
        accept: "text/event-stream",
      },
      signal: controller.signal,
    },
  );
  if (!response.ok || response.body === null) {
    controller.abort();
    throw new Error(`stream open failed: ${response.status}`);
  }

  const frames: StreamTap["frames"] = [];
  const reader = response.body.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          let id: string | undefined;
          let event: string | undefined;
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) continue; // keep-alive comment
            if (line.startsWith("id:")) id = line.slice(3).trim();
            else if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (data === "") continue;
          try {
            frames.push({
              id,
              event,
              data: JSON.parse(data) as TranscriptEvent,
            });
          } catch {
            // Non-JSON data lines are not transcript frames; skip.
          }
        }
      }
    } catch {
      // Aborted or upstream closed — the tap is done either way.
    }
  })();

  return {
    frames,
    async waitForFrame(predicate, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (frames.some(predicate)) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `timed out waiting for stream frame: ${label}; saw ${frames.length} frames: ${JSON.stringify(frames.slice(-5)).slice(0, 1_500)}`,
      );
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
};

/** One turn's current row, read off the conversation's turns list (there is
 * deliberately no GET /v1/turns/:id — turns are a conversation's resource). */
export const readTurn = async (
  v1: V1Client,
  conversationId: string,
  turnId: string,
): Promise<TurnRow | null> => {
  const body = await v1.json<{ turns: TurnRow[] }>(
    await v1.get(`/v1/conversations/${conversationId}/turns`),
  );
  return body.turns.find((turn) => turn.id === turnId) ?? null;
};

/** Post a message and wait for that turn to settle into a terminal status. */
export const runTurn = async (
  v1: V1Client,
  conversationId: string,
  message: string,
  timeoutMs = 90_000,
): Promise<TurnRow> => {
  const created = await v1.json<{ id: string }>(
    await v1.post(`/v1/conversations/${conversationId}/turns`, { message }),
  );
  const settled = await waitFor(
    () => readTurn(v1, conversationId, created.id),
    (turn) =>
      turn !== null && ["done", "failed", "aborted"].includes(turn.status),
    `turn ${created.id} to settle`,
    timeoutMs,
  );
  if (settled === null) throw new Error("unreachable: waitFor returned null");
  return settled;
};
