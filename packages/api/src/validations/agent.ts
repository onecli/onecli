import { z } from "zod";

export const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9-]{0,49}$/;

export const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  identifier: z.string().regex(IDENTIFIER_REGEX, {
    message:
      "Identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
  }),
  parentIdentifier: z
    .string()
    .regex(IDENTIFIER_REGEX, {
      message:
        "Parent identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
    })
    .optional(),
});

export const renameAgentSchema = z.object({
  name: z.string().trim().min(1).max(255),
});

export const secretModeSchema = z.object({
  mode: z.enum(["all", "selective"]),
});

export const updateAgentSecretsSchema = z.object({
  secretIds: z.array(z.string()),
});

export const updateAgentConnectionsSchema = z.object({
  connections: z.array(
    z.object({
      appConnectionId: z.string(),
      // Provider-specific granular-access policy (e.g. Dropbox folders, GitHub
      // repos). Shape is validated per-provider in the service; here we only
      // constrain the envelope.
      sessionPolicy: z.record(z.string(), z.unknown()).nullable().optional(),
    }),
  ),
});

// Reverse of updateAgentConnectionsSchema: the set of selective agents granted
// a given connection, keyed from the connection side.
export const setConnectionAgentsSchema = z.object({
  agentIds: z.array(z.string()),
});
