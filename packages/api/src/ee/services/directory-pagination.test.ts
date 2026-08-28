import { describe, expect, it } from "vitest";
import {
  clampPageLimit,
  decodeCursor,
  encodeCursor,
  toPage,
  DIRECTORY_PAGE_DEFAULT,
  DIRECTORY_PAGE_MAX,
} from "./directory-pagination";
import { ServiceError } from "../../services/errors";

describe("clampPageLimit", () => {
  it("defaults, floors, and caps", () => {
    expect(clampPageLimit(undefined)).toBe(DIRECTORY_PAGE_DEFAULT);
    expect(clampPageLimit(0)).toBe(1);
    expect(clampPageLimit(5)).toBe(5);
    expect(clampPageLimit(9999)).toBe(DIRECTORY_PAGE_MAX);
  });
});

describe("cursor round-trip", () => {
  it("encodes and decodes a keyset position", () => {
    const pos = { name: "HR — ops", id: "grp-1" };
    expect(decodeCursor(encodeCursor(pos))).toEqual(pos);
  });

  it("rejects garbage tokens as BAD_REQUEST", () => {
    for (const bad of ["not-base64!", encodeCursorLike("[1,2]"), ""]) {
      expect(() => decodeCursor(bad)).toThrowError(ServiceError);
    }
  });

  it("rejects positions with non-string values", () => {
    const token = Buffer.from(JSON.stringify({ name: 3 })).toString(
      "base64url",
    );
    expect(() => decodeCursor(token)).toThrowError(ServiceError);
  });
});

const encodeCursorLike = (json: string) =>
  Buffer.from(json, "utf8").toString("base64url");

describe("toPage", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns everything with no nextCursor when under the limit", () => {
    const page = toPage(rows, 3, (last) => ({ id: last.id }));
    expect(page.data).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it("slices the sentinel row and points the cursor at the page's last row", () => {
    const page = toPage(rows, 2, (last) => ({ id: last.id }));
    expect(page.data).toHaveLength(2);
    expect(decodeCursor(page.nextCursor as string)).toEqual({ id: "b" });
  });

  it("handles an empty result", () => {
    const page = toPage([] as { id: string }[], 2, (last) => ({ id: last.id }));
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
