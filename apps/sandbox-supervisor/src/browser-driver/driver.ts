import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Dialog,
  type FileChooser,
  type Frame,
  type Locator,
  type Page,
  type Request as PageRequest,
} from "patchright";
import {
  compactSnapshot,
  DIALOG_ACTIONS_MAX,
  dialogsIn,
  elementsOf,
  matchDialog,
  parseSnapshot,
  type DialogNode,
} from "./snapshot";
import type {
  ModalInfo,
  PendingDialog,
  Reply,
  Request,
  TabInfo,
} from "./protocol";
import type { GetProperty } from "./get-property";
import { describeAction } from "./modal-action";
import { hostOf, onSite, siteOf } from "./site";
import {
  describeTarget,
  ElementIndex,
  resolveTarget,
  type Target,
} from "./target";
import {
  DEVTOOLS_ENDPOINT,
  launchBrowser,
  type LaunchEnvironment,
} from "./launch";
import { containedPath, type ContainmentReason } from "../home/contained-path";

/**
 * The driver: one attached browser, the verbs on it, and the page state each
 * verb answers with. Everything an agent does to a page goes through here.
 *
 * Attaching, never launching, through the DevTools port (`connectOverCDP`)
 * and the browser's FIRST context: that is the persistent profile, where
 * logins live. A `newContext()` would be an incognito window with none of
 * them.
 *
 * Refs: a verb that names an element looks it up by the ref the last
 * snapshot of that tab printed (`aria-ref=`). A ref from an older snapshot
 * is refused up front, with the one fix that works: snapshot again.
 *
 * Waiting: no fixed sleeps. After an action the driver waits for the page
 * to settle (a navigation it caused to finish, the requests it sent to be
 * answered, then the DOM to go quiet for a beat), bounded, and only then
 * reads the page.
 *
 * Dialogs: every reply leads with the page's own dialogs that block it
 * ("Quota exceeded") and what it announced as an alert, read from the page
 * in the same round-trip as its title. An agent that acts past a modal is
 * clicking behind it; a reply that does not say so lets it believe the
 * click landed (observed live: a scripted loop marked real pages as failed
 * for minutes while a quota dialog sat on the screen).
 *
 * JavaScript dialogs: an `alert` is accepted on the spot and reported (it
 * has one answer). A `confirm` or `prompt` is HELD: the page is stopped on
 * it, the verb that raised it answers with the question, and only `dialog
 * accept|dismiss` moves on. Answering for the agent would decide "Delete
 * everything?" on its behalf (the old auto-dismiss always said no, so an
 * agent could never say yes). While a dialog is held the renderer runs
 * nothing: a read of the page would hang, so no verb touches it.
 */

/** DOM quiet for this long after an action counts as settled. */
const SETTLE_QUIET_MS = 300;
/**
 * The most settling waits; a page that never goes quiet still answers.
 * Measured on a news front page under a 4x CPU throttle (the sandbox's
 * shape): the page's own scripts keep the DOM moving for 6 to 8 s after
 * load, and the headlines are all there at 1.5 s. Waiting the cap out
 * bought 15% more elements for 3 s of the agent's time; not worth it.
 */
const SETTLE_MAX_MS = 1_500;
/** A click's navigation request is issued on the next task; this is the look for it. */
const NAVIGATION_GRACE_MS = 100;
/** How long an action's navigation may take to commit before the page is read as is. */
const ACTION_NAVIGATION_MS = 10_000;
/**
 * How long the answers to an action's own requests are waited for (a
 * fetch the click sent, whose answer the page then renders: "saved",
 * "quota exceeded"). Playwright MCP waits up to 5 s for the same; the
 * answers worth waiting for come back well inside 3, and a slower one is
 * still caught by `wait`. A page that sends nothing pays nothing.
 */
const ACTION_REQUESTS_MS = 3_000;
/**
 * The requests that carry an action's result: fetch and xhr to the page's
 * own site (site.ts). Images and fonts never do, and neither do the ad
 * auctions and analytics a click sets off on a news page (measured: a
 * menu click on a news front page started 50 cross-site requests, the
 * slowest answering after 1.4 s; ynet's search button paid 3 s for them).
 * An app whose API lives on another site gets the DOM settle and `wait`.
 */
const RESULT_RESOURCES: ReadonlySet<string> = new Set(["fetch", "xhr"]);
/** `open` and friends: a full navigation the agent asked for. */
const NAVIGATION_TIMEOUT_MS = 30_000;
/**
 * `wait --gone`: how long a progress message may stay up. Long-running
 * checks (a site testing a live URL, an export rendering) take a minute
 * or two; past this the agent hears it is still there and decides.
 */
const GONE_TIMEOUT_MS = 60_000;
/**
 * How long an action waits for its element to be actionable (visible,
 * stable, receiving events). Ad-heavy pages keep elements moving for a
 * while after load; observed live on a 3-CPU sandbox, 5 s was not enough
 * for a forum index.
 */
export const ACTION_TIMEOUT_MS = 15_000;
/**
 * The title of a modal that names itself nowhere (no label, no heading):
 * `modal "(untitled)"` reads as a blocker with no name, where an empty
 * pair of quotes reads as a glitch. Its controls still say what it is.
 */
const UNTITLED_MODAL = "(untitled)";
/**
 * How long an element outside the open modal is given to become reachable
 * by a pointer: long enough for a closing animation to finish. Covered
 * past that, it is behind the modal, and no amount of waiting makes it
 * receive the action. The modal's own controls are exempt.
 */
const BEHIND_MODAL_TIMEOUT_MS = 2_000;
/**
 * The most any one verb may take, end to end. Longer than the longest
 * legitimate one (`wait --ms 60000`, or `open` on a slow page plus its
 * settle); past it the page is treated as wedged (an `eval` that never
 * returns), the attachment is dropped so the next verb starts clean, and
 * the agent gets one line saying so. The browser itself is never killed.
 */
export const VERB_DEADLINE_MS = 75_000;
/** A dialog's or an alert's words are summarized in the header, not reprinted whole. */
const MODAL_TEXT_MAX = 300;
/**
 * Page text that lands in a reply line (a confirm's question, a prompt's
 * prefill, what a field reads after `type`) is clipped to this: a page
 * controls those strings, and a megabyte `confirm()` must not become a
 * megabyte of the agent's context. Modals have the same cap.
 */
const clip = (text: string): string =>
  text.length > MODAL_TEXT_MAX
    ? `${text.slice(0, MODAL_TEXT_MAX - 1).trimEnd()}…`
    : text;
/** The most modals, and the most alerts, a header names; past that the page is noise. */
const OVERLAYS_MAX = 3;
/** `read` keeps a page's worth of text, not a crawl's. */
const READ_MAX_CHARS = 60_000;
/**
 * How long a navigation that landed on a bot check (Cloudflare's "Just a
 * moment…", and the like) is given to clear on its own before the page is
 * reported as it stands. Most clear in 3 to 8 s; a page that is still
 * checking after this wants a person, and the agent is told so.
 */
const CHALLENGE_WAIT_MS = 20_000;
/** What a bot check's interstitial says, in its title or its headings. */
const CHALLENGE_TEXT =
  /just a moment|performing security verification|checking your browser|verify you are human|verifying you are human|attention required|access denied|enable javascript and cookies/i;
/**
 * The hosts the common bot-check vendors serve their interstitial frame
 * from. A page whose body is one such iframe and little else is the
 * check, whatever its title says (DataDome's says only the site's name).
 */
const CHALLENGE_FRAME_HOSTS =
  /captcha-delivery\.com|challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|perimeterx|px-cdn\.net|arkoselabs\.com|funcaptcha/i;

/**
 * A refusal with a message written for the agent: the next step, not the
 * symptom. Every subclass is answered as `ok: false` with its message.
 */
class Refusal extends Error {}

/**
 * A target that names no element of the last snapshot, or more than one.
 * The message is resolveTarget's: what to do instead.
 */
export class TargetError extends Refusal {}

/**
 * An action on an element the open modal covers. The message is the next
 * step, not the symptom: which modal, and the controls that answer it.
 */
class BehindModalError extends Refusal {
  constructor(target: string, modal: ModalInfo) {
    const answers = modal.actions.map(describeAction).join(", ");
    super(
      `${target} is behind the open dialog "${modal.title}"; answer it first${answers ? `: ${answers}` : " (press Escape, or take a snapshot)"}`,
    );
  }
}

/**
 * A click that never reached its element because another element sits on
 * the click point (a cookie banner, a sticky header, a spinner overlay).
 * Playwright retries for the whole action timeout and then reports a bare
 * "Timeout exceeded"; its call log names the interceptor, which is the one
 * thing the agent needs. Observed with agent-browser's wording of the same
 * refusal, which an agent acts on correctly: dismiss the cover first.
 */
class CoveredError extends Refusal {
  constructor(target: string, cover: string) {
    super(
      `${target} is covered by ${cover}; dismiss or close that first, then take a snapshot`,
    );
  }
}

/**
 * The line Playwright's call log writes when a pointer action is
 * intercepted: `<p>…</p> from <div id="banner">…</div> subtree intercepts
 * pointer events`. The subtree root is what the agent dismisses (the
 * banner, not the paragraph in it), so it is the one named; without a
 * `from`, the element itself. The log is coloured for a terminal; the
 * escapes come off first.
 */
const INTERCEPTED =
  /(<[^\n]+?>)(?: from (<[^\n]+?>) subtree)? intercepts pointer events/;
// eslint-disable-next-line no-control-regex -- the escapes are the point
const ANSI = /\u001b\[[0-9;]*m/g;

/** The element the call log says intercepts, as its opening tag. */
const interceptorOf = (message: string): string | undefined => {
  const match = INTERCEPTED.exec(message.replace(ANSI, ""));
  if (!match) return undefined;
  // The log abbreviates an element to `<div id="x">…</div>`; its opening
  // tag is what names it.
  const tag = match[2] ?? match[1] ?? "";
  return /^<[^>]*>/.exec(tag)?.[0];
};

/**
 * `type` landed, but the field reads something else: a masked input that
 * keeps only digits, a widget that swallows the keystrokes, a field the
 * page cleared on input. Playwright's `fill` reports none of this, and an
 * agent told "ok" moves on with a form it did not fill (observed with
 * agent-browser: `fill` behind a modal, exit 0, value unchanged). The
 * message names what landed, unless the text is a secret.
 */
class NotTakenError extends Refusal {
  constructor(target: string, landed: string | null, secret: boolean) {
    super(
      landed === null
        ? `${target} did not take the text; the page may need the field clicked first`
        : secret
          ? `${target} did not take the text (the field reads something else)`
          : `${target} did not take the text: the field reads ${JSON.stringify(clip(landed))}; the page may filter input (try the shape it expects) or need the field clicked first`,
    );
  }
}

/**
 * A verb that needs the page while a JavaScript dialog is holding it. The
 * message is the one way forward.
 */
class DialogHeldError extends Refusal {
  constructor(pending: PendingDialog) {
    super(
      `the page is stopped on a ${pending.type}: ${JSON.stringify(pending.message)}; answer it first: dialog accept${pending.type === "prompt" ? " [text]" : ""} | dialog dismiss`,
    );
  }
}

/**
 * `wait --gone` ran out: the words are still on the screen. Playwright's
 * own message ("Timeout 60000ms exceeded.") says neither what is still
 * there nor what to do about it.
 */
class StillShowingError extends Refusal {
  constructor(text: string) {
    super(
      `"${text}" is still showing after ${String(GONE_TIMEOUT_MS / 1_000)} s; take a screenshot to see why, then wait again or report it`,
    );
  }
}

class DeadlineError extends Error {
  constructor() {
    super(
      `the page did not answer in ${String(VERB_DEADLINE_MS / 1_000)} s; the browser was reattached, try again (reload if the page is stuck)`,
    );
  }
}

interface TabState {
  /** The elements the last snapshot printed: what a verb's target may name. */
  elements: ElementIndex;
  /**
   * The last snapshot of the page before this one (a different document:
   * another snapshot of the same page does not replace it). Only for the
   * refusal of a stale ref: it says what the element was, so the agent
   * can find it on the new page.
   */
  previous: ElementIndex;
  /** The last dialog the page raised, reported once with the next reply. */
  dialog: string | null;
  /**
   * A confirm or prompt the page raised and the driver holds, with what to
   * answer it. Set by the context's dialog handler, cleared by `dialog`.
   */
  held: { dialog: Dialog; info: PendingDialog } | null;
  /** The modals the last reply reported, topmost first. */
  modals: ModalInfo[];
  /**
   * The refs inside the topmost modal (from the last snapshot): the
   * elements an action can still reach while it is open.
   */
  modalRefs: ReadonlySet<string>;
}

export interface DriverOptions {
  environment: LaunchEnvironment;
  /** Where screenshots land when the verb names no path. */
  outputDir: string;
}

/** Names a tab's JavaScript dialog is reported under: what the page asked. */
const describeDialog = (dialog: Dialog): string =>
  `${dialog.type()}: ${clip(dialog.message())}`;

/**
 * An element for a refusal: its role and name as its line reads, when the
 * last snapshot has it with a name; else what the agent typed (a ref, or
 * the nameless role).
 */
const describeElement = (
  element: { role: string; name: string } | undefined,
  target: Target,
): string =>
  element && element.name !== ""
    ? describeTarget({ role: element.role, name: element.name })
    : describeTarget(target);

export class Driver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private active: Page | null = null;
  private readonly tabs = new WeakMap<Page, TabState>();
  private readonly tabIds = new WeakMap<Page, string>();
  private nextTabId = 1;

  constructor(private readonly options: DriverOptions) {}

  /** Attach (launching the browser first if nothing listens). Idempotent. */
  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;
    await launchBrowser(this.options.environment);
    const browser = await chromium.connectOverCDP(DEVTOOLS_ENDPOINT, {
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    // An alert (or a beforeunload) has one answer and gets it here, so it
    // never blocks a verb; the agent is told in the next reply. A confirm
    // or a prompt is a question for the agent: held, and reported by the
    // verb that raised it (act(), which watches for this).
    context.on("dialog", (dialog) => {
      const page = dialog.page();
      const type = dialog.type();
      if (page && (type === "confirm" || type === "prompt")) {
        const state = this.stateOf(page);
        // Two in a row (a page that asks again before the first is read):
        // the earlier one is dismissed so the page can reach the later one.
        void state.held?.dialog.dismiss().catch(() => undefined);
        state.held = {
          dialog,
          info: {
            type,
            message: clip(dialog.message()),
            ...(type === "prompt"
              ? { defaultValue: clip(dialog.defaultValue()) }
              : {}),
          },
        };
        return;
      }
      if (page) this.stateOf(page).dialog = describeDialog(dialog);
      void dialog.accept().catch(() => undefined);
    });
    browser.once("disconnected", () => {
      this.browser = null;
      this.context = null;
      this.active = null;
    });
    this.browser = browser;
    this.context = context;
    this.active = context.pages()[0] ?? (await context.newPage());
  }

  async close(): Promise<void> {
    // A confirm or prompt still held would outlive this attachment and
    // wedge the next one: Chrome answers no CDP attach while a page is
    // stopped on a dialog nobody owns (observed live: every verb after a
    // `stop` timed out at 30 s, forever). Dismiss what is held first; the
    // agent lost the question with the daemon, and a `no` is the safe
    // default answer to one it never gave.
    for (const page of this.context?.pages() ?? []) {
      const state = this.tabs.get(page);
      if (state?.held) {
        const { dialog } = state.held;
        state.held = null;
        await dialog.dismiss().catch(() => undefined);
      }
    }
    // Detach only: the browser and its profile outlive the driver.
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.active = null;
  }

  async handle(request: Request): Promise<Reply> {
    let deadline: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(
        () => reject(new DeadlineError()),
        VERB_DEADLINE_MS,
      );
    });
    try {
      try {
        await this.connect();
        return await Promise.race([this.dispatch(request), expired]);
      } catch (error) {
        if (!isDetached(error)) throw error;
        // The attachment died under us: a renderer the kernel killed on a
        // 2 GB sandbox, a tab the site closed, a CDP session dropped.
        // Observed live: one such error, then every later verb failed the
        // same way for 75 s until the deadline reattached. Reattach now
        // and run the verb once more; an error after that is the answer.
        await this.close();
        await this.connect();
        return await Promise.race([this.dispatch(request), expired]);
      }
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, error: error.message };
      if (error instanceof DeadlineError) {
        await this.close();
        return { ok: false, error: error.message };
      }
      return { ok: false, error: describe(error) };
    } finally {
      clearTimeout(deadline);
    }
  }

  private async dispatch(request: Request): Promise<Reply> {
    const page = this.page();
    // A held confirm or prompt stops the renderer: every read of the page
    // would hang, and every action would queue behind the answer. The one
    // verb that makes progress is the answer.
    const held = this.stateOf(page).held;
    if (held && request.verb !== "dialog") throw new DialogHeldError(held.info);
    switch (request.verb) {
      case "open":
        // Through act(): a page that confirms as it loads ("Leave?", a
        // consent gate) stops there, and act() both sees the dialog and
        // waits the arrival out (the bot-check wait included).
        return this.look(
          await this.act(page, () =>
            page.goto(request.url, { waitUntil: "domcontentloaded" }),
          ),
        );
      case "snapshot":
        return this.look(page, {
          full: request.full === true,
          ...(request.within ? { within: request.within } : {}),
        });
      case "click":
        return this.look(
          await this.act(page, () =>
            this.onTarget(page, request.target, (target) => target.click()),
          ),
        );
      case "type":
        await this.act(page, () =>
          this.onTarget(page, request.target, (target, named) =>
            this.fill(target, request, named),
          ),
        );
        return this.look(page);
      case "press":
        return this.look(
          await this.act(page, () => page.keyboard.press(request.key)),
        );
      case "select":
        await this.act(page, () =>
          this.onTarget(page, request.target, (target) =>
            target.selectOption(request.value),
          ),
        );
        return this.look(page);
      case "hover":
        await this.act(page, () =>
          this.onTarget(page, request.target, (target) => target.hover()),
        );
        return this.look(page);
      case "check":
      case "uncheck":
        // setChecked: a no-op when already in that state, so a loop that
        // re-runs is safe; a click would toggle it back.
        await this.act(page, () =>
          this.onTarget(page, request.target, (target) =>
            target.setChecked(request.verb === "check"),
          ),
        );
        return this.look(page);
      case "upload":
        return this.look(
          await this.act(page, () => this.upload(page, request)),
        );
      case "get":
        // The value alone, no header: a script reads it with $(...), and a
        // url line in front would be part of the value.
        return {
          ok: true,
          url: "",
          title: "",
          got: await this.onTarget(page, request.target, (target) =>
            read(target, request.property),
          ),
        };
      case "scroll": {
        const px =
          (request.pixels ?? 600) * (request.direction === "down" ? 1 : -1);
        await this.act(page, () => page.mouse.wheel(0, px));
        return this.look(page);
      }
      case "back":
        // "commit", not a load event: patchright leaves the back/forward
        // cache on (disabling it is a tell), and a cached restore fires no
        // DOMContentLoaded. The settle below is what waits for the page.
        await page.goBack({ waitUntil: "commit" }).catch(() => undefined);
        await this.settle(page);
        return this.look(page);
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" });
        return this.look(page, { arriving: true });
      case "read":
        return this.readable(page);
      case "screenshot":
        return this.screenshot(page, request);
      case "tabs":
        return this.listTabs(page);
      case "tab":
        return this.switchTab(request.id);
      case "tab-new": {
        const tab = await this.contextOf().newPage();
        this.active = tab;
        if (request.url) {
          await tab.goto(request.url, { waitUntil: "domcontentloaded" });
          return this.look(tab, { arriving: true });
        }
        return this.look(tab);
      }
      case "tab-close": {
        await page.close();
        const next =
          this.contextOf().pages().at(-1) ?? (await this.contextOf().newPage());
        this.active = next;
        return this.look(next);
      }
      case "wait":
        return this.wait(page, request);
      case "eval": {
        const value: unknown = await page.evaluate(request.js);
        return {
          ...(await this.header(page)),
          value: toJsonValue(value),
        };
      }
      case "dialog":
        return this.answerDialog(page, request);
      case "stop":
        // The daemon answers this one itself; reaching here is a bug.
        return { ok: false, error: "stop is handled by the daemon" };
    }
  }

  // ── the page's state ──────────────────────────────────────────────────

  /**
   * The reply's header: url, title, the dialog the browser answered, the
   * page's open modals and alerts, the bot-check flag. `dialogs` is the
   * tree's dialog index when the caller just took a snapshot: it gives
   * each modal the refs of its controls. Without one (read, eval) a modal
   * is reported by its words and its controls' labels.
   */
  private async header(
    page: Page,
    dialogs: readonly DialogNode[] = [],
  ): Promise<Extract<Reply, { ok: true }>> {
    const state = this.stateOf(page);
    const dialog = state.dialog;
    state.dialog = null;
    // Held: the renderer is stopped, so nothing is read from the page. The
    // url is the browser's to give; the title and everything else wait.
    if (state.held) {
      return {
        ok: true,
        url: page.url(),
        title: "",
        ...(dialog ? { dialog } : {}),
        pending: state.held.info,
      };
    }
    const seen = await this.pageState(page);
    const taken = new Set<string>();
    const matched = (seen?.modals ?? []).map((m) => {
      const node = matchDialog(dialogs, m, taken);
      if (node) taken.add(node.ref);
      return { seen: m, node };
    });
    const modals = matched.map(
      ({ seen: m, node }): ModalInfo => ({
        title: m.title || UNTITLED_MODAL,
        text: m.text,
        actions: node?.actions ?? m.labels.map((label) => ({ label })),
      }),
    );
    state.modals = modals;
    state.modalRefs = matched[0]?.node?.refs ?? new Set();
    return {
      ok: true,
      url: page.url(),
      title: seen?.title ?? "",
      ...(dialog ? { dialog } : {}),
      ...(modals.length > 0 ? { modals } : {}),
      ...(seen && seen.alerts.length > 0 ? { alerts: seen.alerts } : {}),
      ...(seen && isChallenge(seen) ? { challenge: true } : {}),
    };
  }

  /**
   * The page's title, its open modals and alerts, and the marks of a bot
   * check, in ONE round-trip. On a heavy page every evaluate queues behind
   * the page's own scripts, so everything the header needs is one read.
   */
  private pageState(page: Page): Promise<PageState | null> {
    return page
      .evaluate(readPageState, [
        MODAL_TEXT_MAX,
        OVERLAYS_MAX,
        DIALOG_ACTIONS_MAX,
      ] as const)
      .catch(() => null);
  }

  private async look(
    page: Page,
    options: { full?: boolean; arriving?: boolean; within?: Target } = {},
  ): Promise<Reply> {
    // The verb's action raised a confirm or prompt: the page is stopped on
    // it, and the reply is the question (nothing else can be read).
    if (this.stateOf(page).held) return this.header(page);
    if (options.arriving) await this.arrive(page);
    const tree = await this.snapshot(page, options);
    const nodes = parseSnapshot(tree);
    const elements = elementsOf(nodes);
    const state = this.stateOf(page);
    const index = new ElementIndex(elements);
    // A scoped snapshot is a view of the last one, not a new one: its refs
    // are the same, and the elements outside it stay nameable.
    if (!options.within) {
      if (index.document !== state.elements.document)
        state.previous = state.elements;
      state.elements = index;
    }
    const header = await this.header(page, dialogsIn(nodes));
    return {
      ...header,
      snapshot: options.full
        ? tree
        : compactSnapshot(elements, state.modalRefs),
    };
  }

  /**
   * The aria tree, without the third-party iframes. The generator descends
   * into every iframe it can see, one round-trip and a retry ladder each;
   * a news front page has 40 of them (ad slots, pixels, syncs) and on a
   * 3-CPU sandbox they turned a 0.6 s snapshot into a 6 s one (measured:
   * 5.0 s with them, 0.8 s with them hidden). What they hold is ads. A
   * same-site iframe (an embedded widget) is kept. The hide is a style
   * rule the page cannot see as a DOM change, present only for the
   * duration of the call, and `visibility` rather than `display` so
   * nothing moves on the screen a person may be watching. `--full` keeps
   * the whole tree: the agent asked for everything. `within` roots the
   * tree at one element of the last snapshot (a form, a table), for a
   * page whose list runs past the cap.
   */
  private async snapshot(
    page: Page,
    options: { full?: boolean; within?: Target },
  ): Promise<string> {
    const root = options.within
      ? page.locator(`aria-ref=${this.resolve(page, options.within)}`)
      : page.locator("body");
    if (options.full) return root.ariaSnapshot({ mode: "ai" });
    const hidden = await page
      .evaluate(hideThirdPartyFrames, siteOf(hostOf(page.url())))
      .catch(() => 0);
    try {
      return await root.ariaSnapshot({ mode: "ai" });
    } finally {
      // Restored without being awaited: the page's main thread is busy on a
      // heavy page and every round-trip queues behind it (measured 200 ms
      // each under load). Nothing after this call reads the frames.
      if (hidden > 0) void page.evaluate(restoreFrames).catch(() => undefined);
    }
  }

  private async readable(page: Page): Promise<Reply> {
    const text = await page.evaluate(readMainText);
    const clipped =
      text.length > READ_MAX_CHARS
        ? `${text.slice(0, READ_MAX_CHARS)}\n… (${String(text.length - READ_MAX_CHARS)} more characters)`
        : text;
    return { ...(await this.header(page)), text: clipped };
  }

  private async screenshot(
    page: Page,
    request: Extract<Request, { verb: "screenshot" }>,
  ): Promise<Reply> {
    const target =
      request.path ??
      `${this.options.outputDir}/screenshot-${String(Date.now())}.png`;
    await page.screenshot({ path: target, fullPage: request.full === true });
    return { ...(await this.header(page)), path: target };
  }

  /**
   * `type`: replace the field's text, then read it back. `fill` returns
   * once the events are dispatched, not once the page kept the text, and
   * the two differ on a masked input, a field whose handler rewrites the
   * value, or a widget that stores keystrokes elsewhere. One extra read on
   * the element, in the same call.
   */
  private async fill(
    target: Locator,
    request: Extract<Request, { verb: "type" }>,
    named: string,
  ): Promise<void> {
    await target.fill(request.text);
    const landed = await target.evaluate(readFieldValue).catch(() => null);
    if (landed === request.text) return;
    // What a password field reads is a secret whichever way the text
    // arrived: an agent that typed one on argv already erred once, and the
    // refusal must not repeat it.
    const secret =
      request.secret === true ||
      (await target.evaluate(isPasswordField).catch(() => true));
    throw new NotTakenError(named, landed, secret);
  }

  /**
   * `upload`: the files, contained under the home (home/contained-path.ts,
   * the rule send_file follows: a page or a prompt that names a path the
   * agent did not mean to send gets nothing), then set on the element. A
   * file input takes them directly, whatever the page did to hide it; a
   * button that opens the picker is clicked and the picker answered. Which
   * one the target is, the element says.
   */
  private async upload(
    page: Page,
    request: Extract<Request, { verb: "upload" }>,
  ): Promise<void> {
    const files = request.paths.map((raw) => {
      const contained = containedPath(this.options.environment.homeDir, raw);
      if (contained.ok) return contained.path;
      throw new Refusal(uploadRefusal(raw, contained.reason));
    });
    await this.onTarget(page, request.target, async (target, named) => {
      if (await target.evaluate(isFileInput)) {
        await target.setInputFiles(files);
        return;
      }
      // Not a file input: a button (or a drop zone's link) that opens the
      // picker when clicked. The picker is caught and answered; a click
      // that opens none is refused as such, not as a bare timeout.
      const chooser = page.waitForEvent("filechooser", {
        timeout: ACTION_TIMEOUT_MS,
      });
      chooser.catch(() => undefined);
      await target.click();
      let picker: FileChooser;
      try {
        picker = await chooser;
      } catch (error) {
        if (error instanceof errors.TimeoutError)
          throw new Refusal(
            `${named} is not a file field and clicking it opened no file picker; upload onto the file field itself (often a button named like its label)`,
          );
        throw error;
      }
      await picker.setFiles(files);
    });
  }

  /**
   * `dialog accept|dismiss`: answer the confirm or prompt the page is
   * stopped on, then read the page as it stands after. The verb that
   * raised the dialog was abandoned mid-action (its promise settles once
   * the renderer runs again, into a catch); the page's state after the
   * answer is what the agent needs to see.
   */
  private async answerDialog(
    page: Page,
    request: Extract<Request, { verb: "dialog" }>,
  ): Promise<Reply> {
    const state = this.stateOf(page);
    const held = state.held;
    if (!held)
      throw new Refusal(
        "no dialog is open; this verb answers a confirm or a prompt the page raised",
      );
    state.held = null;
    // The dialog may already be gone (the tab navigated or closed under
    // it): then there is nothing to answer and the page is simply read.
    await (
      request.answer === "accept"
        ? held.dialog.accept(request.text)
        : held.dialog.dismiss()
    ).catch(() => undefined);
    state.dialog = `${describeDialog(held.dialog)} (${request.answer === "accept" ? "accepted" : "dismissed"})`;
    // What the answer set off: a navigation ("Leave page?"), a fetch, a
    // re-render, or the NEXT question (a page that confirms twice in a
    // row). The page runs again on the next task; give it that task before
    // reading, so a second dialog is held and reported, not hung on.
    await delay(NAVIGATION_GRACE_MS);
    if (state.held) return this.header(page);
    await this.settle(page);
    return this.look(page);
  }

  private async listTabs(active: Page): Promise<Reply> {
    const tabs: TabInfo[] = [];
    for (const p of this.contextOf().pages()) {
      tabs.push({
        id: this.idOf(p),
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: p === active,
      });
    }
    return { ...(await this.header(active)), tabs };
  }

  private async switchTab(id: string): Promise<Reply> {
    const page = this.contextOf()
      .pages()
      .find((p) => this.idOf(p) === id);
    if (!page)
      return { ok: false, error: `no tab ${id}; run tabs to list them` };
    this.active = page;
    await page.bringToFront();
    return this.look(page);
  }

  private async wait(
    page: Page,
    request: Extract<Request, { verb: "wait" }>,
  ): Promise<Reply> {
    // Visible matches only, both ways: a hidden copy of the words (a
    // template, a screen-reader label) that sits earlier in the page must
    // not end a --gone wait at once, nor stall a --text one.
    if (request.text !== undefined) {
      await page
        .getByText(request.text)
        .filter({ visible: true })
        .first()
        .waitFor({ state: "visible", timeout: NAVIGATION_TIMEOUT_MS });
    } else if (request.gone !== undefined) {
      // Gone from sight, not from the DOM: a progress dialog that finishes
      // is usually hidden, and its text stays in the document.
      try {
        await page
          .getByText(request.gone)
          .filter({ visible: true })
          .first()
          .waitFor({ state: "hidden", timeout: GONE_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof errors.TimeoutError)
          throw new StillShowingError(request.gone);
        throw error;
      }
    } else if (request.url !== undefined) {
      await page.waitForURL(request.url, { timeout: NAVIGATION_TIMEOUT_MS });
    } else if (request.ms !== undefined) {
      await page.waitForTimeout(request.ms);
    } else {
      await this.settle(page);
    }
    return this.look(page);
  }

  // ── acting and settling ───────────────────────────────────────────────

  /**
   * Run one action, then wait for what it set off before anyone reads the
   * page: a navigation it requested (the request is seen even when the
   * server takes seconds to answer), the answers to the fetches it sent
   * (the result a page renders: "saved", "quota exceeded"), then the DOM
   * going quiet. Returns the page to read afterwards: a tab the action
   * opened (a target=_blank link) becomes the active one, as it does for
   * a person.
   *
   * A confirm or prompt the action raised stops the page, and with it the
   * action (Playwright's click waits for the handler to return, and the
   * handler is waiting for the agent). The dialog handler marks the tab
   * held; the action is left to settle on its own once the dialog is
   * answered, and the verb answers now with the question.
   */
  private async act(page: Page, action: () => Promise<unknown>): Promise<Page> {
    const state = this.stateOf(page);
    const main = page.mainFrame();
    const site = siteOf(hostOf(page.url()));
    let requested = false;
    let opened: Page | null = null;
    const answers: Promise<unknown>[] = [];
    let committed: () => void = () => undefined;
    const commit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let heldNow: () => void = () => undefined;
    const held = new Promise<"held">((resolve) => {
      heldNow = () => resolve("held");
    });
    const onRequest = (request: PageRequest) => {
      if (request.isNavigationRequest() && request.frame() === main)
        requested = true;
      else if (
        RESULT_RESOURCES.has(request.resourceType()) &&
        onSite(hostOf(request.url()), site)
      )
        answers.push(request.response().catch(() => null));
    };
    const onNavigated = (frame: Frame) => {
      if (frame === main) committed();
    };
    const onPopup = (popup: Page) => {
      opened = popup;
    };
    const onDialog = (dialog: Dialog) => {
      if (dialog.type() === "confirm" || dialog.type() === "prompt") heldNow();
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigated);
    page.on("popup", onPopup);
    page.on("dialog", onDialog);
    try {
      // The action's own failure is the verb's answer; a dialog ends the
      // wait first. The action promise is kept from becoming an unhandled
      // rejection when it settles later (a timeout once the dialog is
      // answered): its outcome is not this verb's to report.
      const acted = action();
      const outcome = await Promise.race([acted, held]);
      if (outcome === "held") {
        acted.catch(() => undefined);
        return page;
      }
      await delay(NAVIGATION_GRACE_MS);
      // Raised after the action returned (a handler on a timer, a submit
      // that confirms on the next task): the settle below would hang on
      // the stopped renderer, so the question is the answer here too.
      if (state.held) return page;
      if (requested) await Promise.race([commit, delay(ACTION_NAVIGATION_MS)]);
      else if (answers.length > 0)
        await Promise.race([Promise.all(answers), delay(ACTION_REQUESTS_MS)]);
    } finally {
      page.off("request", onRequest);
      page.off("framenavigated", onNavigated);
      page.off("popup", onPopup);
      page.off("dialog", onDialog);
    }
    const target: Page = opened ?? page;
    if (opened) this.active = opened;
    if (requested || opened) {
      await target
        .waitForLoadState("domcontentloaded", { timeout: ACTION_NAVIGATION_MS })
        .catch(() => undefined);
      await this.arrive(target);
    } else {
      await this.settle(target);
    }
    return target;
  }

  /**
   * After a navigation: settle, and if what loaded is a bot check, wait
   * for it to clear. The check is a page of its own (a title, a heading,
   * a spinner) that reloads into the real one when it passes; a snapshot
   * taken during it shows the agent nothing to act on, and the agent then
   * sleeps and retries by hand (observed live: four rounds of `sleep &&
   * snapshot`, 70 s, before the page was there). Waiting here turns that
   * into one call. A check that does not clear is reported as it is, with
   * `challenge` set so the reply can say what to do.
   */
  private async arrive(page: Page): Promise<void> {
    await this.settle(page);
    if (!(await this.onChallenge(page))) return;
    const deadline = Date.now() + CHALLENGE_WAIT_MS;
    while (Date.now() < deadline) {
      await delay(500);
      if (!(await this.onChallenge(page))) {
        // The check cleared into the real page, which may still be on its
        // way: the clearance is a reload, and on a slow server the new
        // document can sit with no <body> for seconds (observed: 8 s).
        // A snapshot then fails on "body does not match"; wait for it.
        await page
          .waitForLoadState("domcontentloaded", {
            timeout: ACTION_NAVIGATION_MS,
          })
          .catch(() => undefined);
        await page
          .locator("body")
          .waitFor({ state: "attached", timeout: ACTION_NAVIGATION_MS })
          .catch(() => undefined);
        await this.settle(page);
        return;
      }
    }
  }

  /** Whether the page showing now is a bot check's interstitial. */
  private async onChallenge(page: Page): Promise<boolean> {
    const seen = await this.pageState(page);
    return seen !== null && isChallenge(seen);
  }

  /**
   * Settled: no content mutation for SETTLE_QUIET_MS, or SETTLE_MAX_MS
   * elapsed. Measured in the page itself. Attribute changes are not counted:
   * a CSS animation toggling classes would never let the page go quiet, and
   * the async changes worth waiting for (a fetch rendering its result) add
   * nodes or text. A document that goes away mid-wait is a late navigation:
   * wait for the new one, then once more for quiet.
   */
  private async settle(page: Page): Promise<void> {
    const quiet = () =>
      page.evaluate(waitForQuietDom, [SETTLE_QUIET_MS, SETTLE_MAX_MS] as const);
    try {
      await quiet();
    } catch {
      await page
        .waitForLoadState("domcontentloaded", { timeout: ACTION_NAVIGATION_MS })
        .catch(() => undefined);
      await quiet().catch(() => undefined);
    }
  }

  // ── bookkeeping ───────────────────────────────────────────────────────

  private page(): Page {
    const active = this.active;
    if (!active || active.isClosed()) {
      const pages = this.contextOf().pages();
      const fallback = pages.at(-1);
      if (!fallback) throw new Error("no open tab; run open <url>");
      this.active = fallback;
      return fallback;
    }
    return active;
  }

  private contextOf(): BrowserContext {
    if (!this.context) throw new Error("no browser; run open <url>");
    return this.context;
  }

  /**
   * Run `action` on the element `target` names in the tab's last snapshot
   * (resolveTarget: one element, or a refusal that says what to do). While
   * the last reply showed a modal, an element outside it is first checked
   * for whether a pointer reaches it (a trial click, short wait), whatever
   * the verb: fill and selectOption never ask, so a field behind a modal
   * would take the call and change nothing. Waiting longer does not
   * uncover it. The refusal names the modal and the controls that answer
   * it, the one thing to do next; Playwright's own message ("element
   * intercepts pointer events", or a bare timeout) says neither. A modal
   * that does not cover the element (a non-blocking aria-modal panel)
   * passes the check. An action that times out because something else
   * covers the element (a banner the page never called a dialog) is
   * answered with what covers it, read off Playwright's call log.
   */
  private async onTarget<T>(
    page: Page,
    target: Target,
    action: (element: Locator, named: string) => Promise<T>,
  ): Promise<T> {
    const state = this.stateOf(page);
    const ref = this.resolve(page, target);
    const element = page.locator(`aria-ref=${ref}`);
    // The element as its line reads (`textbox "PIN"`), whichever way the
    // agent named it: a refusal about a ref should still say what it was.
    const named = describeElement(state.elements.get(ref), target);
    const modal = state.modals[0];
    if (modal !== undefined && !state.modalRefs.has(ref)) {
      try {
        await element.click({ trial: true, timeout: BEHIND_MODAL_TIMEOUT_MS });
      } catch (error) {
        if (error instanceof errors.TimeoutError)
          throw new BehindModalError(named, modal);
        throw error;
      }
    }
    try {
      return await action(element, named);
    } catch (error) {
      const cover =
        error instanceof errors.TimeoutError
          ? interceptorOf(error.message)
          : undefined;
      if (cover) throw new CoveredError(named, cover);
      throw error;
    }
  }

  /** The ref `target` names in the tab's last snapshot, or a TargetError. */
  private resolve(page: Page, target: Target): string {
    const state = this.stateOf(page);
    const resolved = resolveTarget(target, state.elements, {
      previous: state.previous,
      within: state.modalRefs,
    });
    if ("error" in resolved) throw new TargetError(resolved.error);
    return resolved.ref;
  }

  private stateOf(page: Page): TabState {
    let state = this.tabs.get(page);
    if (!state) {
      state = {
        elements: new ElementIndex([]),
        previous: new ElementIndex([]),
        dialog: null,
        held: null,
        modals: [],
        modalRefs: new Set(),
      };
      this.tabs.set(page, state);
    }
    return state;
  }

  private idOf(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) {
      id = `t${String(this.nextTabId)}`;
      this.nextTabId += 1;
      this.tabIds.set(page, id);
    }
    return id;
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The errors that mean the attachment, not the page, is gone. */
const isDetached = (error: unknown): boolean =>
  error instanceof Error &&
  /has been closed|Target closed|Session closed|Browser closed|Connection closed|not connected|crashed/i.test(
    error.message,
  );

/** `eval`'s result as one JSON value: what the page handed back, or null for what JSON cannot carry. */
const toJsonValue = (value: unknown): unknown => {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  )
    return null;
  if (typeof value === "bigint") return value.toString();
  return value;
};

/** `get`: one property of the element, as a person would read it. */
const read = async (
  element: Locator,
  property: GetProperty,
): Promise<string | null> => {
  switch (property) {
    case "text":
      return element.innerText();
    case "value":
      // A password's value never leaves the page by this door: printed, it
      // would sit in the agent's transcript (the same reason `type e7 -`
      // reads it from stdin). `type` still checks it landed, internally.
      if (await element.evaluate(isPasswordField))
        throw new Refusal(
          "the value of a password field is not read back; check the page's reaction instead",
        );
      return element.evaluate(readFieldValue);
    case "href":
      return element.evaluate(readHref);
  }
};

/** The one line `upload` refuses a path with. */
const uploadRefusal = (raw: string, reason: ContainmentReason): string => {
  switch (reason) {
    case "outside":
      return `${raw}: only files under your home directory can be uploaded`;
    case "missing":
      return `${raw}: no file at that path`;
    case "loop":
      return `${raw}: that path is a symlink loop`;
    case "unresolvable":
      return `${raw}: that path could not be resolved`;
  }
};

/** What one read of the page tells: its title, its open modals and alerts, the bot-check marks. */
interface PageState {
  title: string;
  headings: string;
  frames: string;
  textLength: number;
  /** Topmost first. `labels` are its controls' names, for pairing with the tree. */
  modals: { title: string; text: string; labels: string[] }[];
  alerts: string[];
}

/**
 * Runs in the page: everything a reply's header needs, in one trip. The
 * title and the bot-check marks; the dialogs blocking the page, by the
 * platform's own rules (a native modal `<dialog>`, `aria-modal="true"`, an
 * `alertdialog`, or a dialog whose site made the rest of the page `inert`
 * or `aria-hidden`, which is how MUI, Radix and Headless UI mark one);
 * and what the page announced in `role=alert`. A dialog that is merely
 * present is not reported: a side menu marked `role=dialog` (Search
 * Console's is) blocks nothing, and naming it a modal would be the same
 * mistake as missing a real one.
 *
 * The page-side functions are exported for one test: it serializes each
 * the way `page.evaluate` does and runs it in a bare context, so a helper
 * leaking into one fails loudly there instead of silently in a `.catch`.
 *
 * Every function handed to `page.evaluate` is serialized from its source
 * and run in the page, where nothing of this module exists. They are
 * written without nested closures on purpose: a transform that wraps inner
 * arrows in a helper (tsx's `__name` does, for a function's `.name`) would
 * make the page throw `__name is not defined`, and with the `.catch`
 * fallbacks around these calls that failure is silent. Plain loops only.
 */
export const readPageState = ([textMax, overlaysMax, labelsMax]: readonly [
  number,
  number,
  number,
]): PageState => {
  let headings = "";
  for (const h of document.querySelectorAll("h1, h2")) {
    headings += `${h.textContent ?? ""} | `;
  }
  let frames = "";
  for (const f of document.querySelectorAll("iframe")) {
    frames += `${f.getAttribute("src") ?? ""} `;
  }

  const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"]';
  const above: HTMLElement[] = [];
  const below: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(dialogSelector)) {
    // Said not to be modal by its author (a consent box, a chat panel).
    if (el.getAttribute("aria-modal") === "false") continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    // Parked off screen: a closed drawer slid out of view.
    if (
      box.right <= 0 ||
      box.bottom <= 0 ||
      box.left >= window.innerWidth ||
      box.top >= window.innerHeight
    )
      continue;
    let modal =
      el.getAttribute("aria-modal") === "true" ||
      el.getAttribute("role") === "alertdialog" ||
      (el instanceof HTMLDialogElement && el.matches(":modal"));
    if (!modal) {
      // The rest of the page hidden around it: a shown top-level sibling
      // of the dialog's own top-level ancestor is inert or aria-hidden.
      // Only top-level: a decorative icon marked aria-hidden next to a
      // side menu is not the page being hidden. Only shown: a library
      // keeps its closed dialogs mounted, aria-hidden and full-screen
      // under visibility:hidden (observed on mui.com: a consent box
      // reported as modal on every reply).
      let top: HTMLElement = el;
      while (top.parentElement && top.parentElement !== document.body)
        top = top.parentElement;
      for (const sibling of document.body.children) {
        if (sibling === top) continue;
        if (
          !sibling.hasAttribute("inert") &&
          sibling.getAttribute("aria-hidden") !== "true"
        )
          continue;
        if (!sibling.checkVisibility({ checkVisibilityCSS: true })) continue;
        const area = sibling.getBoundingClientRect();
        if (area.width > 0 && area.height > 0) {
          modal = true;
          break;
        }
      }
    }
    if (!modal) continue;
    // Topmost: what a person sees at its centre belongs to it.
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    if (hit && el.contains(hit)) above.push(el);
    else below.push(el);
  }
  const open = [...above.reverse(), ...below.reverse()].slice(0, overlaysMax);

  const modals: PageState["modals"] = [];
  for (const el of open) {
    // Its name, and the elements it was read from: their words are the
    // title, not the text. Words that merely begin like the title (an
    // aria-label "Testing" over "Testing if live URL can be indexed")
    // are the text, whole.
    const titled: Element[] = [];
    let name = "";
    for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
      // A label element with no text names itself by its title: a
      // consent wall labelled by the iframe that holds it (observed on
      // spiegel.de: the iframe's title is "Privacy Center").
      const label = id ? document.getElementById(id) : null;
      if (!label) continue;
      titled.push(label);
      name += ` ${label.textContent?.trim() || label.getAttribute("title") || ""}`;
    }
    if (name.trim() === "") name = el.getAttribute("aria-label") ?? "";
    if (name.trim() === "") {
      const heading = el.querySelector(
        'h1, h2, h3, h4, h5, h6, [role="heading"]',
      );
      if (heading) {
        titled.push(heading);
        name = heading.textContent ?? "";
      }
    }
    const title = name.replace(/\s+/g, " ").trim();

    // Its words: the visible text that is its own, not its title's, not a
    // control's label (those are listed as controls), not a nested
    // dialog's.
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node && text.length <= textMax;
      node = walker.nextNode()
    ) {
      const parent = node.parentElement;
      if (!parent || parent.closest(dialogSelector) !== el) continue;
      let inTitle = false;
      for (const t of titled) if (t.contains(parent)) inTitle = true;
      if (inTitle) continue;
      const control = parent.closest(
        'button, a[href], [role="button"], [role="link"], select, script, style, template',
      );
      if (control && el.contains(control)) continue;
      if (!parent.checkVisibility()) continue;
      text += ` ${node.textContent ?? ""}`;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > textMax)
      text = `${text.slice(0, textMax - 1).trimEnd()}…`;

    const labels: string[] = [];
    for (const control of el.querySelectorAll<HTMLElement>(
      'button, a[href], [role="button"], [role="link"], input[type="button"], input[type="submit"]',
    )) {
      if (labels.length >= labelsMax) break;
      if (control.closest(dialogSelector) !== el) continue;
      if (!control.checkVisibility()) continue;
      const label = (
        control.getAttribute("aria-label") ||
        (control instanceof HTMLInputElement
          ? control.value
          : control.innerText) ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (label) labels.push(label);
    }
    modals.push({ title, text, labels });
  }

  const alerts: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[role="alert"]')) {
    if (alerts.length >= overlaysMax) break;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      continue;
    // An alert inside an open modal is that modal's words, already said.
    let inModal = false;
    for (const m of open) if (m.contains(el)) inModal = true;
    if (inModal) continue;
    let said = el.innerText.replace(/\s+/g, " ").trim();
    if (said.length > textMax)
      said = `${said.slice(0, textMax - 1).trimEnd()}…`;
    if (said) alerts.push(said);
  }

  return {
    title: document.title,
    headings,
    frames,
    textLength: (document.body?.innerText ?? "").trim().length,
    modals,
    alerts,
  };
};

/**
 * A bot check, by its title or headings, or by a vendor's interstitial
 * frame on an otherwise empty page. The same frame on a page WITH content
 * is a widget on a form, not a wall.
 */
const isChallenge = (seen: PageState): boolean =>
  CHALLENGE_TEXT.test(seen.title) ||
  CHALLENGE_TEXT.test(seen.headings) ||
  (CHALLENGE_FRAME_HOSTS.test(seen.frames) && seen.textLength < 200);

/**
 * Runs in the page: marks every iframe that is not on `site`, the page's
 * own (siteOf; a third-party ad slot, a tracking pixel, a src-less frame
 * an ad script wrote into) and hides them with one style rule. Returns
 * how many. The comparison is onSite's, inline: a page function carries
 * nothing of this module.
 */
export const hideThirdPartyFrames = (site: string): number => {
  let marked = 0;
  for (const frame of document.querySelectorAll("iframe")) {
    const src = frame.getAttribute("src") ?? "";
    let host = "";
    try {
      host = src ? new URL(src, location.href).hostname : "";
    } catch {
      host = "";
    }
    if (host === site || host.endsWith(`.${site}`)) continue;
    frame.setAttribute("data-onecli-skip", "");
    marked += 1;
  }
  if (marked > 0) {
    const style = document.createElement("style");
    style.id = "onecli-skip";
    style.textContent =
      "iframe[data-onecli-skip]{visibility:hidden !important}";
    document.documentElement.appendChild(style);
  }
  return marked;
};

/**
 * Runs in the page: the page's readable text. The `main` or `article`
 * holding the most text, when it holds at least a quarter of the page's;
 * the whole body otherwise. Neither the first `article` nor the largest
 * is enough on its own: a news page marks every comment card as one and
 * puts the story in a plain div (observed live: 8 `<article>`s of 150 to
 * 265 characters, all comments, on an 11,000-character story), so `read`
 * answered with a reader's comment and the agent fell back to `eval` with
 * CSS selectors. A quarter is far above any comment card and below any
 * real article column. No nested closures (see readPageSigns).
 */
export const readMainText = (): string => {
  const body = document.body.innerText;
  let root = document.body;
  let most = body.length / 4;
  for (const candidate of document.querySelectorAll<HTMLElement>(
    "main, article",
  )) {
    const length = candidate.innerText.length;
    if (length >= most) {
      most = length;
      root = candidate;
    }
  }
  return root.innerText.replace(/\n{3,}/g, "\n\n");
};

/** Runs in the page: undoes hideThirdPartyFrames. */
export const restoreFrames = (): void => {
  document.getElementById("onecli-skip")?.remove();
  for (const frame of document.querySelectorAll("iframe[data-onecli-skip]")) {
    frame.removeAttribute("data-onecli-skip");
  }
};

/**
 * Runs in the page, on one element: what the field holds. A form control's
 * value; a contenteditable's text; null for an element that is neither
 * (the caller reads that as "not a field").
 */
export const readFieldValue = (el: Element): string | null => {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  )
    return el.value;
  if (el instanceof HTMLElement && el.isContentEditable) return el.innerText;
  return null;
};

/** Runs in the page, on one element: the link's resolved href, or the nearest link's. */
export const readHref = (el: Element): string | null => {
  const link = el.closest("a[href], area[href]");
  return link instanceof HTMLAnchorElement || link instanceof HTMLAreaElement
    ? link.href
    : null;
};

/** Runs in the page, on one element: whether it is a file input. */
export const isFileInput = (el: Element): boolean =>
  el instanceof HTMLInputElement && el.type === "file";

/** Runs in the page, on one element: whether it is a password input. */
export const isPasswordField = (el: Element): boolean =>
  el instanceof HTMLInputElement && el.type === "password";

/**
 * Runs in the page: resolves after `quiet` ms without a content mutation,
 * or at `max`. Anonymous callbacks only (see readPageSigns): a named inner
 * function is what a `.name`-preserving transform wraps.
 */
export const waitForQuietDom = ([quiet, max]: readonly [number, number]) =>
  new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(stop);
        resolve();
      }, quiet);
    });
    const stop = setTimeout(() => {
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    }, max);
    timer = setTimeout(() => {
      observer.disconnect();
      clearTimeout(stop);
      resolve();
    }, quiet);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

/** One short line for the agent, never a stack. */
const describe = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n")[0] ?? message;
  return first
    .replace(/^(locator|page|browserType|browser|frame)\.\w+: /, "")
    .replace(/^Error: /, "")
    .replace(/Call log:.*$/s, "")
    .trim();
};
