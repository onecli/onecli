import { z } from "zod";
import { REF, ROLE } from "./target";

/**
 * The wire between the `onecli-browser` command and the driver daemon: one
 * JSON request line in, one JSON reply line out, over a unix socket in the
 * agent's home. The verbs are the whole surface an agent is taught; every
 * one that changes the page answers with the page's state afterwards, so
 * "act, then look" is one call.
 *
 * A verb that acts on an element names it by a ref (`e12`) or by the role
 * and name its line printed (`button "Send"`), both from the LAST snapshot
 * of the current tab (target.ts). No CSS, no coordinates.
 */

/**
 * What a verb acts on: `{ref}` or `{role, name}`, never both. A ref is
 * `e12`, or `f1e12` with the frame's sequence in front (an iframe, or the
 * main frame after it has navigated once); the prefix is what makes a ref
 * from before a navigation fail to resolve instead of hitting the wrong
 * element. A name is the one the line printed, whole.
 */
export const targetSchema = z.union(
  [
    z.strictObject({ ref: z.string().regex(REF, "a ref looks like e12") }),
    z.strictObject({
      role: z.string().regex(ROLE, "a role looks like button"),
      name: z.string().min(1).max(1_024),
    }),
  ],
  { error: 'a target is a ref (e12) or a role and a name (button "Send")' },
);

const url = z.string().min(1).max(8_192);
/** Bounded like every wire string: a page's worth of typed text, not a file. */
const text = z.string().max(65_536);
const key = z.string().min(1).max(64);
const scrollDirection = z.enum(["down", "up"]);

export const requestSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("open"), url }),
  z.object({ verb: z.literal("snapshot"), full: z.boolean().optional() }),
  z.object({ verb: z.literal("click"), target: targetSchema }),
  z.object({ verb: z.literal("type"), target: targetSchema, text }),
  z.object({ verb: z.literal("press"), key }),
  z.object({ verb: z.literal("select"), target: targetSchema, value: text }),
  z.object({ verb: z.literal("hover"), target: targetSchema }),
  z.object({
    verb: z.literal("scroll"),
    direction: scrollDirection,
    pixels: z.number().int().positive().max(20_000).optional(),
  }),
  z.object({ verb: z.literal("back") }),
  z.object({ verb: z.literal("reload") }),
  z.object({ verb: z.literal("read") }),
  z.object({
    verb: z.literal("screenshot"),
    path: z.string().max(4_096).optional(),
  }),
  z.object({ verb: z.literal("tabs") }),
  z.object({ verb: z.literal("tab"), id: z.string().min(1).max(32) }),
  z.object({ verb: z.literal("tab-new"), url: url.optional() }),
  z.object({ verb: z.literal("tab-close") }),
  z.object({
    verb: z.literal("wait"),
    text: z.string().min(1).max(1_024).optional(),
    /** Wait for this text to leave the screen (a "Testing…" dialog closing). */
    gone: z.string().min(1).max(1_024).optional(),
    url: z.string().min(1).max(1_024).optional(),
    ms: z.number().int().positive().max(60_000).optional(),
  }),
  z.object({ verb: z.literal("eval"), js: text }),
  z.object({ verb: z.literal("stop") }),
]);
export type Request = z.infer<typeof requestSchema>;
export type Verb = Request["verb"];

/** One open tab, as `tabs` lists it. */
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/**
 * A control that answers a modal: what it says, and its ref when the reply
 * printed the element list it belongs to (`read` and `eval` print none).
 */
export interface ModalAction {
  label: string;
  ref?: string;
}

/**
 * A dialog that blocks the page (a native modal `<dialog>`, `aria-modal`,
 * an `alertdialog`, or a dialog the site made everything else inert or
 * aria-hidden around), as a person sees it: what it is called, what it
 * says, and how to answer it. Topmost first when more than one is open.
 */
export interface ModalInfo {
  title: string;
  text: string;
  actions: ModalAction[];
}

/** What the daemon answers. `ok: false` carries one short, actionable error. */
export type Reply =
  | {
      ok: true;
      url: string;
      title: string;
      /** The page's element list (or full tree), for verbs that look. */
      snapshot?: string;
      /** The page as readable text (`read`). */
      text?: string;
      /** Where the screenshot landed (`screenshot`). */
      path?: string;
      /** The open tabs (`tabs`). */
      tabs?: TabInfo[];
      /** `eval`'s JSON result. */
      value?: unknown;
      /** A JavaScript dialog the page raised and the driver answered. */
      dialog?: string;
      /**
       * The page's own dialogs blocking it now ("Quota exceeded"): an
       * agent that acts past one is clicking behind it.
       */
      modals?: ModalInfo[];
      /** What the page announced as an alert (a toast, a form error). */
      alerts?: string[];
      /**
       * The page showing is a bot check ("Just a moment…") that did not
       * clear on its own. Nothing on it is for the agent to act on.
       */
      challenge?: true;
    }
  | { ok: false; error: string };
