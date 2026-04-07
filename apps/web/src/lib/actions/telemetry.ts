"use server";

import {
  isTelemetryEnabled,
  isTelemetryForcedByEnv,
  setTelemetryPreference,
} from "@/lib/telemetry";

export const getTelemetryStatus = async () => {
  return {
    enabled: isTelemetryEnabled(),
    forcedByEnv: isTelemetryForcedByEnv(),
  };
};

export const updateTelemetryPreference = async (enabled: boolean) => {
  if (isTelemetryForcedByEnv()) {
    throw new Error(
      "Telemetry is disabled by environment variable and cannot be changed from the dashboard.",
    );
  }
  setTelemetryPreference(enabled);
  return { enabled };
};
