import { describe, expect, it } from "vitest";
import { formatBytes } from "./format-bytes";

describe("formatBytes", () => {
  it("picks the unit a reader expects, one decimal past bytes", () => {
    expect(formatBytes(0)).toBe("0\u00a0B");
    expect(formatBytes(812)).toBe("812\u00a0B");
    expect(formatBytes(1024)).toBe("1\u00a0KB");
    expect(formatBytes(4300)).toBe("4.2\u00a0KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5\u00a0MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3\u00a0GB");
  });

  it("never shows a negative size", () => {
    expect(formatBytes(-5)).toBe("0\u00a0B");
  });
});
