import { z } from "zod";
import { AGENT_EFFORTS, KNOWN_AGENT_HARNESSES } from "@onecli/agent-protocol";

export const IDENTIFIER_REGEX = /^[a-z0-9][a-z0-9-]{0,49}$/;

export const AGENT_KINDS = ["byo", "hosted"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** The per-agent brief (§3.11) — generous, but bounded well below TOAST pain. */
export const INSTRUCTIONS_MAX_LENGTH = 20_000;

const hostedOnlyFieldsRule = (
  data: {
    kind: AgentKind;
    harness?: string;
    instructions?: string;
  },
  ctx: z.RefinementCtx,
) => {
  if (data.kind === "byo") {
    for (const field of ["harness", "instructions"] as const) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only valid for hosted agents`,
        });
      }
    }
  }
};

export const createAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    identifier: z.string().regex(IDENTIFIER_REGEX, {
      message:
        "Identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
    }),
    kind: z.enum(AGENT_KINDS).default("byo"),
    // The column stays a free string (the adapter-#2 seam — schema.prisma),
    // but the API refuses ids no composition root can boot: a typo here would
    // otherwise be stored, then silently run the default adapter. "fake" is
    // deliberately creatable — the conformance/e2e tooling may drive it
    // through the real API (hosted-e2e seeds via prisma today, but the API
    // must not be narrower than the composition root it feeds).
    harness: z.enum(KNOWN_AGENT_HARNESSES).optional(),
    // No `model` at creation, deliberately (§3.10): the granted key names the
    // provider and the provider supplies the default, so asking here would be
    // asking for something nobody can answer yet. It is set afterwards through
    // PATCH, which can stamp the provider alongside it.
    instructions: z.string().max(INSTRUCTIONS_MAX_LENGTH).optional(),
    parentIdentifier: z
      .string()
      .regex(IDENTIFIER_REGEX, {
        message:
          "Parent identifier must be 1-50 characters, start with a letter or number, and contain only lowercase letters, numbers, and hyphens",
      })
      .optional(),
  })
  .superRefine(hostedOnlyFieldsRule);

export const updateAgentSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    // null clears the brief; kind/harness are immutable after create.
    instructions: z.string().max(INSTRUCTIONS_MAX_LENGTH).nullable().optional(),
    // The model/effort OVERRIDE (§3.10). null clears it, returning the agent
    // to its provider's default — which is the normal state, not a fallback.
    // `modelProvider` is deliberately absent: the SERVICE stamps it from the
    // agent's granted key, so the pair can never be written half-set.
    model: z.string().trim().min(1).max(200).nullable().optional(),
    effort: z.enum(AGENT_EFFORTS).nullable().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.instructions !== undefined ||
      data.model !== undefined ||
      data.effort !== undefined,
    {
      message: "At least one field to update is required",
    },
  );

/**
 * POST /agents/:agentId/ssh-certificate (sandbox-platform step 5). Exactly
 * one source: a pasted public key (ed25519 only — the interop-proven cert
 * path; the service re-parses and refuses anything else with an actionable
 * message) OR a registered key's id. Strict objects make the arms mutually
 * exclusive — a body carrying both fails both and is refused, never
 * silently resolved in favor of one.
 */
export const mintSshCertificateSchema = z.union([
  z.object({ publicKey: z.string().trim().min(1).max(1024) }).strict(),
  z.object({ sshKeyId: z.string().trim().min(1).max(128) }).strict(),
]);

export type MintSshCertificateInput = z.infer<typeof mintSshCertificateSchema>;
