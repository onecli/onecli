import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locating the gateway binary.
 *
 * `CARGO_BIN_EXE_*` is only set for test targets inside the package that
 * declares the binary, so it is unavailable to us and we resolve by path.
 *
 * A binary that cannot be found is never a skip. It means the suite is wired
 * wrong, and silently passing would defeat the point of having it.
 */

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const candidates = (): ReadonlyArray<readonly [string, string]> => {
  const override = process.env.GATEWAY_E2E_BIN;
  const found: Array<readonly [string, string]> = [];
  if (override !== undefined && override !== "") {
    found.push(["$GATEWAY_E2E_BIN", override]);
  }
  for (const profile of ["debug", "release"]) {
    found.push([
      `../gateway/target/${profile}`,
      join(packageDir, "..", "gateway", "target", profile, "onecli-gateway"),
    ]);
  }
  return found;
};

let cached: string | undefined;

export const gatewayBinary = (): string => {
  if (cached !== undefined) return cached;

  const tried = candidates();
  for (const [, path] of tried) {
    if (existsSync(path)) {
      cached = path;
      return path;
    }
  }

  const listing = tried
    .map(([label, path], i) => `  ${i + 1}. ${label} → ${path}`)
    .join("\n");
  throw new Error(
    `cannot find the onecli-gateway binary. Tried:\n${listing}\n\n` +
      `Build it first:\n` +
      `  cargo build --manifest-path apps/gateway/Cargo.toml --bin onecli-gateway\n` +
      `or set GATEWAY_E2E_BIN to an existing binary.`,
  );
};

/**
 * Guard that the intended edition actually reached the child process.
 *
 * The binary is edition-less; the runtime env decides. If the spawn env lost
 * the variable the gateway would silently run as the other edition — different
 * workspace resolution, different key rechecks — and the failures would look
 * like anything but the real cause, so assert the boot line reports what the
 * test meant to start (the suite default is Onprem — the enterprise lane; the
 * cloud lane opts into Cloud).
 */
export const assertEdition = (
  bootLine: Readonly<Record<string, unknown>>,
  expected: "Cloud" | "Onprem",
): void => {
  const edition = bootLine["edition"];
  if (edition !== expected) {
    throw new Error(
      `the gateway booted as edition ${String(edition)}, not ${expected} — ` +
        `the EDITION env did not reach the child process (check the spawn env).`,
    );
  }
};
