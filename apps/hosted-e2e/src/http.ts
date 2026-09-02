/**
 * The small amount of HTTP the harness parses by hand.
 *
 * Two of the three clients here read raw sockets — the CONNECT reply and the
 * request sent inside a MITM tunnel — so they cannot lean on `node:http` to
 * parse for them. This module holds the pieces they share with the stub server,
 * rather than each growing its own copy.
 */

/** A response, however it was obtained (node:http, or parsed off a socket). */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  header(name: string): string | undefined;
  json(): unknown;
}

/** Collapse Node's `string | string[] | undefined` header bag to lowercase strings. */
export const flattenHeaders = (
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value))
      headers[key.toLowerCase()] = value.join(", ");
  }
  return headers;
};

/** Parse `Name: value` lines off the wire. */
export const parseHeaderLines = (
  lines: ReadonlyArray<string>,
): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx > 0)
      headers[line.slice(0, idx).trim().toLowerCase()] = line
        .slice(idx + 1)
        .trim();
  }
  return headers;
};

/** `HTTP/1.1 403 Forbidden` → `403`. */
export const parseStatusLine = (statusLine: string): number =>
  Number.parseInt(statusLine.split(" ")[1] ?? "0", 10);

export const makeResponse = (
  status: number,
  headers: Readonly<Record<string, string>>,
  body: string,
): HttpResponse => ({
  status,
  headers,
  body,
  header: (name: string) => headers[name.toLowerCase()],
  json: () => JSON.parse(body) as unknown,
});

/** Split a raw response into its head lines and body at the blank line. */
export const splitHeadAndBody = (
  raw: string,
): { head: string[]; body: string } => {
  const split = raw.indexOf("\r\n\r\n");
  const head = (split === -1 ? raw : raw.slice(0, split)).split("\r\n");
  return { head, body: split === -1 ? "" : raw.slice(split + 4) };
};
