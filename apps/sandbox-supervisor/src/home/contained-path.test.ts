import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { containedPath } from "./contained-path";

/**
 * The one containment rule for files that leave by the agent's hand
 * (send_file, onecli-browser upload). send-file.test.ts proves it through
 * that tool; this pins the helper itself, so a second caller cannot drift.
 */
describe("containedPath", () => {
  let home: string;
  let outside: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "contained-home-"));
    outside = mkdtempSync(join(tmpdir(), "contained-outside-"));
    writeFileSync(join(home, "report.pdf"), "x");
    writeFileSync(join(outside, "secret"), "s");
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("resolves a file under the home, by absolute or home-relative path", () => {
    for (const raw of [
      join(home, "report.pdf"),
      "report.pdf",
      "./report.pdf",
    ]) {
      const result = containedPath(home, raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path.endsWith("/report.pdf")).toBe(true);
    }
  });

  it("follows a symlink that stays inside the home", () => {
    mkdirSync(join(home, "runs"));
    writeFileSync(join(home, "runs", "clip.webm"), "v");
    symlinkSync(join(home, "runs", "clip.webm"), join(home, "latest.webm"));
    const result = containedPath(home, "latest.webm");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith("/runs/clip.webm")).toBe(true);
  });

  it("refuses every way out: traversal, an absolute path, a leaf symlink, a parent symlink, the home itself", () => {
    symlinkSync(join(outside, "secret"), join(home, "innocent.txt"));
    symlinkSync(outside, join(home, "docs"));
    for (const raw of [
      "../x",
      join("..", outside.slice(outside.lastIndexOf("/") + 1), "secret"),
      join(outside, "secret"),
      "innocent.txt",
      "docs/secret",
      ".",
      home,
    ]) {
      expect(containedPath(home, raw)).toEqual({
        ok: false,
        reason: "outside",
      });
    }
  });

  it("names a missing file and a symlink loop", () => {
    expect(containedPath(home, "nope.pdf")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(containedPath(home, "report.pdf/inner")).toEqual({
      ok: false,
      reason: "missing",
    });
    symlinkSync(join(home, "loop"), join(home, "loop"));
    expect(containedPath(home, "loop")).toEqual({ ok: false, reason: "loop" });
  });
});
