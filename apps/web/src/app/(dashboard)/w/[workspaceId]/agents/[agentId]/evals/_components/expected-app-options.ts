import { getApp } from "@onecli/api/apps/registry";
import { isLlmHost } from "@onecli/api/lib/path-match";
import {
  EVAL_APP_ID_MAX_LENGTH,
  EVAL_HOST_PREFIX,
  isConcreteHost,
  normalizeLoggedHost,
} from "@onecli/api/validations/evals";
import type { EffectiveCredentialsResult } from "@/lib/api/policy-visibility";

export interface ExpectedAppOption {
  /** What the check stores: a provider ID, or `host:<hostname>`. */
  id: string;
  label: string;
  /** Why it cannot be chosen, when it cannot. */
  unavailable?: string;
}

/**
 * The apps a test question can require, from the credentials THIS agent can
 * actually use (its effective grants, never the whole workspace):
 * - a connected app is checked by its provider ID, so several accounts of
 *   one app are one check;
 * - a custom app is checked by its exact host (`host:api.example.com`);
 *   a wildcard or otherwise non-concrete host cannot be checked.
 * Model providers are not apps the agent "used", so they are left out.
 */
export const expectedAppOptions = (
  credentials: EffectiveCredentialsResult,
): ExpectedAppOption[] => {
  const options = new Map<string, ExpectedAppOption>();
  for (const entry of credentials.connections) {
    if (entry.kind !== "connection") continue;
    const id = entry.provider.trim().toLowerCase();
    if (!id || options.has(id)) continue;
    options.set(id, { id, label: getApp(id)?.name ?? id });
  }
  for (const entry of credentials.secrets) {
    if (entry.kind !== "secret") continue;
    const host = normalizeLoggedHost(entry.host.trim());
    if (isLlmHost(host)) continue;
    const id = `${EVAL_HOST_PREFIX}${host}`;
    const existing = options.get(id);
    if (existing) {
      options.set(id, {
        ...existing,
        label: `${existing.label}, ${entry.name}`,
      });
      continue;
    }
    options.set(id, {
      id,
      label: entry.name,
      ...(!isConcreteHost(host)
        ? { unavailable: "Only an exact host can be checked" }
        : id.length > EVAL_APP_ID_MAX_LENGTH
          ? { unavailable: "This host name is too long to check" }
          : {}),
    });
  }
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
};

/** How a stored app ID reads: the option's label, or the raw ID for an app
 * this agent can no longer use (shown so it can be removed). */
export const appLabel = (
  id: string,
  options: readonly ExpectedAppOption[],
): string => {
  const option = options.find((o) => o.id === id);
  if (option) return option.label;
  if (id.startsWith(EVAL_HOST_PREFIX)) return id.slice(EVAL_HOST_PREFIX.length);
  return getApp(id)?.name ?? id;
};
