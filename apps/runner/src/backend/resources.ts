import type { SandboxSpec } from "./types";
import type { SandboxStartResources } from "@onecli/agent-protocol";

/**
 * The home size a backend that cannot provision homes implicitly promises:
 * the fixed workspace volume every self-hosted sandbox gets. A backend that
 * provisions homes states its own `defaultHomeGiB`.
 */
export const IMPLICIT_HOME_GIB = 20;

/** Older profile senders omitted axes, so an override cannot be assumed harmless. */
export const resourceOverrideAxes = (
  resources: SandboxStartResources,
): Readonly<NonNullable<SandboxStartResources["overrideAxes"]>> =>
  resources.overrideAxes ??
  (resources.hasOverrides ? ["cpu", "memory", "home"] : []);

/** Refuse inconsistent callers instead of applying one profile and reporting another. */
export const assertResourceLimits = (spec: SandboxSpec): void => {
  if (
    spec.resources &&
    (spec.resources.profile.cpuMillicores !==
      Math.round(spec.limits.cpus * 1000) ||
      spec.resources.profile.memoryMiB !== spec.limits.memoryMb)
  ) {
    throw new Error("sandbox limits do not match the resource profile");
  }
};
