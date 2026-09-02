import { ServiceError } from "../../services/errors";

/**
 * The directory-list envelope: every directory-scale collection (groups,
 * memberships, members) pages with an opaque cursor. Cursors encode a keyset
 * position, so pages stay correct under concurrent membership churn (exactly
 * what SCIM sync produces) — offset pagination would skip or duplicate rows
 * there.
 */
export interface DirectoryPage<T> {
  data: T[];
  nextCursor: string | null;
}

export const DIRECTORY_PAGE_DEFAULT = 50;
export const DIRECTORY_PAGE_MAX = 200;

export const clampPageLimit = (limit?: number): number =>
  Math.min(Math.max(limit ?? DIRECTORY_PAGE_DEFAULT, 1), DIRECTORY_PAGE_MAX);

/** Encode a keyset position as an opaque cursor token. */
export const encodeCursor = (position: Record<string, string>): string =>
  Buffer.from(JSON.stringify(position), "utf8").toString("base64url");

/**
 * Decode a cursor token into its keyset position. Malformed or truncated
 * tokens are a caller error (BAD_REQUEST), never a 500.
 */
export const decodeCursor = (token: string): Record<string, string> => {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    );
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string")
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the shared error below
  }
  throw new ServiceError("BAD_REQUEST", "Invalid cursor");
};

/**
 * Slice a `take: limit + 1` result set into a page and its nextCursor —
 * `cursorOf` extracts the keyset position of the page's last row.
 */
export const toPage = <T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => Record<string, string>,
): DirectoryPage<T> => {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
  };
};
