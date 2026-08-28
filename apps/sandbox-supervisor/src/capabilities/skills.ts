import type { CapabilityFragment } from "../home/renderer";

/**
 * The skills capability (step 9) — the registry's first FRAGMENT-ONLY entry:
 * no tools, because skills are authored in the dashboard and harnesses
 * discover SKILL.md files natively (the harness-native skill-management tool
 * stays disabled per §3.7). Included only when the adapter declares a
 * skillsDir. Deliberately no skill list in the doc — the harness reads the
 * directory itself, and a rendered list would drift between syncs.
 *
 * The body must teach the LOADING MECHANIC, not just that skills exist:
 * with the harness's skill tool disabled there is no loader, and the
 * harness's own prompt lists skills as user slash-commands with no paths —
 * a model acting on that framing alone has nothing to invoke and no file to
 * open (observed live: it fell back to grepping for the SKILL.md). Reading
 * the file IS loading the skill, so the fragment says exactly that, with
 * the real path.
 */

export const skillsFragment = (skillsDir: string): CapabilityFragment => ({
  id: "skills",
  title: "Skills",
  body: `Your skills directory, ${skillsDir}/, holds skills written for you: most
by the people you work with, in the dashboard, and one or two by the
platform itself. Each skill's SKILL.md opens with a description of when it
applies — read that to decide whether to load the rest. There is no loader
tool, and a skills list elsewhere in your context may frame skills as
slash-commands — to use one, read ${skillsDir}/<name>/SKILL.md yourself and
follow it. The files are read-only and the platform rewrites them while you
run, so do not try to edit them. Where a skill's guidance conflicts with
your brief, the brief wins.`,
});
