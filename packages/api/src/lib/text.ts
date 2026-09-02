/**
 * Sanitizers for platform-authored text that enters a model prompt.
 *
 * `stripControl`'s implementation moved to @onecli/agent-protocol with the
 * memory file format (the render normalization must be ONE definition on
 * both sides of the wire); this re-export keeps every existing import path.
 */
export { stripControl } from "@onecli/agent-protocol";
