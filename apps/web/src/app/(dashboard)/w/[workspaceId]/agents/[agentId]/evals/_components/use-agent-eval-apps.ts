"use client";

import { useEffectiveCredentials } from "@/lib/api/policy-visibility";
import {
  appLabel as labelFor,
  expectedAppOptions,
  type ExpectedAppOption,
} from "./expected-app-options";

export interface AgentEvalApps {
  /** The apps a question can require for this agent. */
  options: ExpectedAppOption[];
  /** A stored app ID in words. */
  appLabel: (id: string) => string;
  state: "loading" | "error" | "ready";
  retry: () => void;
}

/**
 * The apps this agent can use, as checkable options. Effective credentials
 * are fetched only while `enabled`, so the Evals page loads nothing extra
 * until a question is being written.
 */
export const useAgentEvalApps = (
  agentId: string,
  enabled: boolean,
): AgentEvalApps => {
  const credentials = useEffectiveCredentials(agentId, enabled);
  const options = credentials.data ? expectedAppOptions(credentials.data) : [];
  return {
    options,
    appLabel: (id) => labelFor(id, options),
    state: credentials.isError
      ? "error"
      : credentials.data
        ? "ready"
        : "loading",
    retry: () => void credentials.refetch(),
  };
};
