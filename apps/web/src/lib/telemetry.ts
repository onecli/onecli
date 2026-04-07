import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

/**
 * Preference file path — Docker uses /app/data/, local dev falls back to ~/.onecli/.
 */
const PREF_FILE = existsSync("/app/data")
  ? "/app/data/telemetry-preference"
  : join(homedir(), ".onecli", "telemetry-preference");

/**
 * Reads the telemetry preference. Priority:
 *   1. DO_NOT_TRACK=1 env var → disabled
 *   2. Preference file → "on" or "off"
 *   3. Default → enabled
 */
export const isTelemetryEnabled = (): boolean => {
  if (process.env.DO_NOT_TRACK === "1") return false;

  try {
    return readFileSync(PREF_FILE, "utf-8").trim() !== "off";
  } catch {
    return true;
  }
};

/**
 * Whether the preference is forced by an environment variable
 * (cannot be changed from the dashboard).
 */
export const isTelemetryForcedByEnv = (): boolean => {
  return process.env.DO_NOT_TRACK === "1";
};

/**
 * Persists the telemetry preference to disk.
 * In Docker, entrypoint.sh reads this file on next container start.
 */
export const setTelemetryPreference = (enabled: boolean): void => {
  mkdirSync(dirname(PREF_FILE), { recursive: true });
  writeFileSync(PREF_FILE, enabled ? "on" : "off", "utf-8");
};
