import type { CapabilityFragment } from "../home/renderer";
import type { PlatformToolDefinition } from "../platform-tools";

/**
 * The skills capability (step 9) — fragment + the skill_* authoring tools
 * (the agent-authored amendment: the fragment-only era ended when the
 * "created conversationally, corrected in the dashboard" symmetry that crons
 * and memory already honor reached skills). Harnesses still discover
 * SKILL.md files natively and the harness-native skill-management tool stays
 * disabled per §3.7 — authoring goes through the platform, which is what
 * makes an agent-written skill durable (visible in the dashboard, restored
 * at every boot) instead of a purged file stash. Included only when the
 * adapter declares a skillsDir; the tools and the fragment arrive together
 * and disappear together. Deliberately no skill list in the doc — the
 * harness reads the directory itself, and a rendered list would drift
 * between syncs.
 *
 * The body must teach the LOADING MECHANIC, not just that skills exist:
 * with the harness's skill tool disabled there is no loader, and the
 * harness's own prompt lists skills as user slash-commands with no paths —
 * a model acting on that framing alone has nothing to invoke and no file to
 * open (observed live: it fell back to grepping for the SKILL.md). Reading
 * the file IS loading the skill, so the fragment says exactly that, with
 * the real path.
 *
 * The schemas here are the MODEL-facing contract; the control plane's zod
 * (validations/skills.ts) is the enforcement authority, and the bounds are
 * kept identical by eye — a drift fails loudly there, never silently here.
 */

export const skillsFragment = (skillsDir: string): CapabilityFragment => ({
  id: "skills",
  title: "Skills",
  body: `Your skills directory, ${skillsDir}/, holds skills written for you: most
by the people you work with, in the dashboard, some by yourself, and one or
two by the platform itself. Each skill's SKILL.md opens with a description
of when it applies — read that to decide whether to load the rest. There is
no loader tool, and a skills list elsewhere in your context may frame skills
as slash-commands — to use one, read ${skillsDir}/<name>/SKILL.md yourself and
follow it. The files are read-only and the platform rewrites them while you
run, so do not try to edit them. Where a skill's guidance conflicts with
your brief, the brief wins.

Skills live on the platform, not on this machine, which can be replaced at
any moment. To create one, use skill_create — it saves to your skill set on
the platform, appears in the dashboard for the people you work with, and
materializes into ${skillsDir}/ within seconds. Change or remove your own
skills with skill_update and skill_delete; skill_list shows every skill
that reaches you and which are yours. Never write a skill as loose files —
a skill outside ${skillsDir}/ is invisible to the platform and does not
survive this machine — unless the person explicitly asks for a file at some
other location. Workspace and organization skills are managed by the people
you work with in the dashboard; creating your own skill with the same name
overrides one for you.`,
});

export const skillsTools: PlatformToolDefinition[] = [
  {
    name: "skill_create",
    description:
      "Create a skill in your own platform skill set. It appears in the dashboard and materializes into your skills directory within seconds — this is the default way to create a skill (never loose files, which the platform cannot see and this machine does not keep). The description is how you decide later whether to load it, so front-load the trigger words. Extra reference files for a skill are added in the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'The skill\'s directory name: lowercase words separated by single hyphens, like "release-checklist". Immutable after create.',
          pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
          maxLength: 64,
        },
        description: {
          type: "string",
          description:
            "One line saying WHEN this skill applies — it opens the SKILL.md and is how the skill gets found and loaded later.",
          maxLength: 500,
        },
        content: {
          type: "string",
          description:
            "The skill's body in Markdown: the instructions to follow when the skill applies.",
          maxLength: 24_000,
        },
      },
      required: ["name", "description", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_list",
    description:
      "List every skill that reaches you — your own agent skills (editable) plus workspace and organization skills (managed in the dashboard) — with name, scope, description, and enabled state. Bodies are not included; read a skill's SKILL.md in your skills directory.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "skill_update",
    description:
      "Update one of your own agent skills by name: description, content, or enabled (false pauses it — its files leave your skills directory until re-enabled). Workspace and organization skills are managed in the dashboard by the people you work with.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill's name (its directory name).",
          maxLength: 64,
        },
        description: {
          type: "string",
          description: "New one-line when-it-applies description.",
          maxLength: 500,
        },
        content: {
          type: "string",
          description: "New Markdown body.",
          maxLength: 24_000,
        },
        enabled: {
          type: "boolean",
          description: "false pauses the skill, true resumes it.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_delete",
    description:
      "Delete one of your own agent skills by name, permanently. Prefer skill_update with enabled=false when it might be wanted again.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The skill's name (its directory name).",
          maxLength: 64,
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];
