import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMountReadOnly,
  READ_ONLY_WATCH_INTERVAL_MS,
  watchHomeReadOnly,
} from "./read-only-watch";

/** A stacked table: the root, another mount of the home's path underneath,
 * and the home's own filesystem mounted over it (the visible entry). */
const table = (homeOptions: string): string =>
  [
    "overlay / overlay rw,relatime 0 0",
    "tmpfs /workspace tmpfs rw,nodev,relatime 0 0",
    `/dev/sdb /workspace ext4 ${homeOptions} 0 0`,
    "tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,size=131072k,mode=700 0 0",
  ].join("\n");

describe("isMountReadOnly", () => {
  it("reads the visible (last) mount of the path, not the one under it", () => {
    expect(isMountReadOnly(table("rw,relatime,discard"), "/workspace")).toBe(
      false,
    );
    expect(isMountReadOnly(table("ro,relatime,discard"), "/workspace")).toBe(
      true,
    );
  });

  it("needs the exact option, never a substring of another", () => {
    // `errors=remount-ro` and `ro` inside other words are not read-only.
    const tricky =
      "/dev/sdb /workspace ext4 rw,errors=remount-ro,nobarrier 0 0";
    expect(isMountReadOnly(tricky, "/workspace")).toBe(false);
  });

  it("reads ext4's emergency read-only (6.15+) as read-only, though the table says rw", () => {
    // The table after an ext4 error on a 6.15+ kernel: `rw` stays,
    // `emergency_ro` is added, every write fails EROFS.
    expect(
      isMountReadOnly(table("rw,relatime,discard,emergency_ro"), "/workspace"),
    ).toBe(true);
    // A forced shutdown fails every write too.
    expect(
      isMountReadOnly(table("rw,relatime,discard,shutdown"), "/workspace"),
    ).toBe(true);
    // Still exact options, and still only the visible mount.
    expect(
      isMountReadOnly(table("rw,relatime,noemergency_ro_x"), "/workspace"),
    ).toBe(false);
    const under = [
      "/dev/old /workspace ext4 rw,emergency_ro 0 0",
      "/dev/sdb /workspace ext4 rw,relatime 0 0",
    ].join("\n");
    expect(isMountReadOnly(under, "/workspace")).toBe(false);
  });

  it("is false for a path that is not mounted, and for another path", () => {
    expect(isMountReadOnly(table("ro"), "/home")).toBe(false);
    expect(isMountReadOnly("", "/workspace")).toBe(false);
    // A prefix is a different mount point.
    expect(
      isMountReadOnly("/dev/x /workspace2 ext4 ro 0 0", "/workspace"),
    ).toBe(false);
  });

  it("matches a mount point whose name holds a space (procfs escapes it)", () => {
    expect(isMountReadOnly("/dev/x /my\\040home ext4 ro 0 0", "/my home")).toBe(
      true,
    );
  });
});

describe("watchHomeReadOnly", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once, at the first read-only reading, and never again", () => {
    vi.useFakeTimers();
    let options = "rw,relatime";
    const fired = vi.fn();
    watchHomeReadOnly("/workspace", fired, {
      readMounts: () => table(options),
    });
    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS * 3);
    expect(fired).not.toHaveBeenCalled();

    // How the fault reads on a 6.15+ kernel.
    options = "rw,relatime,emergency_ro";
    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS);
    expect(fired).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS * 5);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("checks at once, so a home already read-only at start is reported", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    watchHomeReadOnly("/workspace", fired, {
      readMounts: () => table("ro"),
    });
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable table as no evidence and keeps watching", () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const errors: unknown[] = [];
    let broken = true;
    watchHomeReadOnly("/workspace", fired, {
      readMounts: () => {
        if (broken) throw new Error("EIO");
        return table("ro");
      },
      onReadError: (error) => errors.push(error),
    });
    expect(fired).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    // Reported once, not every tick: a missing procfs never comes back.
    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS * 3);
    expect(errors).toHaveLength(1);

    broken = false;
    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it("stops polling when stopped", () => {
    vi.useFakeTimers();
    const readMounts = vi.fn(() => table("rw"));
    const stop = watchHomeReadOnly("/workspace", vi.fn(), { readMounts });
    stop();
    vi.advanceTimersByTime(READ_ONLY_WATCH_INTERVAL_MS * 5);
    expect(readMounts).toHaveBeenCalledTimes(1);
  });
});
