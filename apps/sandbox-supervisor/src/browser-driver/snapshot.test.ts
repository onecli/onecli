import { describe, expect, it } from "vitest";
import {
  compactSnapshot,
  dialogsIn,
  elementsOf,
  matchDialog,
  MAX_LINES,
  parseSnapshot,
} from "./snapshot";

/** The views take the parse; the tests start from the text. */
const elements = (tree: string) => elementsOf(parseSnapshot(tree));
const compact = (tree: string) => compactSnapshot(elements(tree));

/**
 * The fixture is a real `ariaSnapshot({ mode: "ai" })` of a page with every
 * shape the filter must handle: nested links, nameless icon links, a
 * disabled button, a frame-prefixed `f1e2` ref, options inside a combobox (no
 * ref of their own), `/url` and `/placeholder` child lines, and a quoted
 * name with an escaped quote.
 */
const TREE = `- generic [active] [ref=e1]:
  - navigation [ref=e2]:
    - link "Home" [ref=e3] [cursor=pointer]:
      - /url: /home
    - link "Forums" [ref=e4] [cursor=pointer]:
      - /url: /forum
  - heading "Welcome" [level=1] [ref=e5]
  - paragraph [ref=e6]: Some paragraph text that is not interactive.
  - generic [ref=e7]:
    - generic [ref=e8]:
      - text: Email
      - textbox "Email" [ref=e9]:
        - /placeholder: you@example.com
    - searchbox "Search" [ref=e10]
    - combobox "Sort" [ref=e11]:
      - option "Newest" [selected]
      - option "Oldest"
    - checkbox "Remember me" [ref=e12]
    - text: Remember me
    - button "Sign in" [ref=e13]
  - tablist [ref=e14]:
    - tab "One" [ref=e15]
    - tab "Two" [selected] [ref=e16]
  - img "A picture" [ref=e17]
  - link [ref=e18] [cursor=pointer]:
    - /url: "#"
    - img "Icon link" [ref=e19]
  - button "Disabled" [disabled] [ref=e20]
  - link "Say \\"hi\\"" [ref=e21] [cursor=pointer]:
    - /url: /x
  - heading "Section" [level=2] [ref=e22]
  - list [ref=e23]:
    - listitem [ref=e24]: item one
    - listitem [ref=e25]:
      - link "item link" [ref=e26] [cursor=pointer]:
        - /url: /i
  - iframe [ref=e27]:
    - button "In frame" [ref=f1e2]
  - textbox "Body" [ref=e28]
  - 'link "Documents: Police officer gave her login to a colleague" [ref=e29] [cursor=pointer]':
    - /url: item?id=1
  - 'button "Rock ''n'' roll: play" [ref=e30]'
`;

describe("compactSnapshot", () => {
  it("lists the open modal's elements first, so the line cap never cuts them", () => {
    const lines = compactSnapshot(
      elements(DIALOGS),
      new Set(["e10", "e11"]),
    ).split("\n");
    expect(lines.slice(0, 1)).toEqual(['e11 button "Dismiss"']);
    expect(lines).toContain('e7 button "REQUEST INDEXING"');
    // Past the cap, the modal's control is still in the list.
    const crowded = `${Array.from(
      { length: MAX_LINES + 50 },
      (_, i) => `- link "Story ${String(i)}" [ref=e${String(i + 100)}]`,
    ).join("\n")}\n- dialog "Quota" [ref=e1]:\n  - button "Dismiss" [ref=e2]\n`;
    expect(compactSnapshot(elements(crowded), new Set(["e2"]))).toContain(
      'e2 button "Dismiss"',
    );
    expect(compact(crowded)).not.toContain('e2 button "Dismiss"');
  });
  it("keeps what an agent can act on, one line each, in page order", () => {
    expect(compact(TREE)).toBe(
      [
        'e3 link "Home"',
        'e4 link "Forums"',
        'e5 heading "Welcome" [level=1]',
        'e9 textbox "Email"',
        'e10 searchbox "Search"',
        'e11 combobox "Sort"',
        'e12 checkbox "Remember me"',
        'e13 button "Sign in"',
        'e15 tab "One"',
        'e16 tab "Two" [selected]',
        'e18 link "Icon link"',
        'e20 button "Disabled" [disabled]',
        'e21 link "Say "hi""',
        'e22 heading "Section" [level=2]',
        'e26 link "item link"',
        'f1e2 button "In frame"',
        'e28 textbox "Body"',
        'e29 link "Documents: Police officer gave her login to a colleague"',
        "e30 button \"Rock 'n' roll: play\"",
      ].join("\n"),
    );
  });

  it("drops paragraphs, images, text runs, options without a ref, and the url/placeholder children", () => {
    const out = compact(TREE);
    for (const absent of [
      "paragraph",
      "img",
      "/url",
      "placeholder",
      "Newest",
      "item one",
      "generic",
      "list ",
    ]) {
      expect(out).not.toContain(absent);
    }
  });

  it("caps the list and says how to see the rest", () => {
    const many = Array.from(
      { length: MAX_LINES + 25 },
      (_, i) => `- link "L${String(i)}" [ref=e${String(i + 1)}]`,
    ).join("\n");
    const lines = compact(many).split("\n");
    expect(lines).toHaveLength(MAX_LINES + 1);
    expect(lines.at(-1)).toBe("… 25 more elements: scroll, or snapshot --full");
  });

  it("is empty, not broken, for a page with nothing to act on", () => {
    expect(compact("- generic [ref=e1]:\n  - paragraph [ref=e2]: hi")).toBe("");
    expect(compact("")).toBe("");
  });
});

describe("elementsOf", () => {
  const byRef = new Map(elements(TREE).map((e) => [e.ref, e]));

  it("lists every ref in the tree, iframe refs included, nothing else", () => {
    expect(byRef.has("e1")).toBe(true);
    expect(byRef.has("e24")).toBe(true);
    expect(byRef.has("f1e2")).toBe(true);
    expect(byRef.has("e99")).toBe(false);
    // The single-quoted keys (a name with ": " in it) are refs too: a click
    // on one was refused as stale before the parser learned the wrapping.
    expect(byRef.has("e29")).toBe(true);
    expect(byRef.has("e30")).toBe(true);
    expect(byRef.size).toBe(31);
  });

  it("names each element exactly as its line prints it, which is what a target matches", () => {
    // An icon link reads as its image's name; an escaped quote, a YAML
    // quoted key, and a doubled apostrophe come back as the page has them.
    expect(byRef.get("e18")).toMatchObject({ role: "link", name: "Icon link" });
    expect(byRef.get("e21")?.name).toBe('Say "hi"');
    expect(byRef.get("e29")?.name).toBe(
      "Documents: Police officer gave her login to a colleague",
    );
    expect(byRef.get("e30")?.name).toBe("Rock 'n' roll: play");
    // The tree escapes a backslash too: the name is the page's, one
    // backslash, so the line and a target typed from it agree.
    expect(
      elements(String.raw`- button "C:\\temp\\out" [ref=e1]`)[0]?.name,
    ).toBe(String.raw`C:\temp\out`);
    expect(byRef.get("f1e2")).toMatchObject({
      role: "button",
      name: "In frame",
    });
  });
});

describe("parseSnapshot", () => {
  it("reads flags worth showing and ignores the cursor hint", () => {
    const byRef = new Map(parseSnapshot(TREE).map((l) => [l.ref, l]));
    expect(byRef.get("e16")?.flags).toEqual(["selected"]);
    expect(byRef.get("e20")?.flags).toEqual(["disabled"]);
    expect(byRef.get("e3")?.flags).toEqual([]);
    expect(byRef.get("e1")?.flags).toEqual(["active"]);
  });
});

/**
 * A real `ariaSnapshot({ mode: "ai" })` of the shapes that matter: a side
 * menu marked `role=dialog` (Search Console's), a quota alertdialog, a
 * native modal `<dialog>` named only by its heading, and a cookie dialog
 * with a nested confirm.
 */
const DIALOGS = `- generic [ref=e1]:
  - dialog "Main menu" [ref=e2]:
    - link "Overview" [ref=e3] [cursor=pointer]:
      - /url: "#"
  - main [ref=e5]:
    - button "REQUEST INDEXING" [ref=e7]
  - alertdialog "Quota Exceeded" [ref=e8]:
    - generic [ref=e10]: Sorry--we couldn't process this request.
    - button "Dismiss" [ref=e11]
  - dialog [ref=e12]:
    - heading "Native" [level=2] [ref=e13]
    - button "Close" [active] [ref=e15]
  - dialog "Cookie consent" [ref=e16]:
    - button "Accept" [ref=e17]
    - link [ref=e18] [cursor=pointer]:
      - img "Settings" [ref=e19]
    - dialog "Are you sure?" [ref=e20]:
      - button "Yes" [ref=e21]
`;

describe("dialogsIn", () => {
  const dialogs = dialogsIn(parseSnapshot(DIALOGS));
  const byRef = new Map(dialogs.map((d) => [d.ref, d]));

  it("indexes every dialog with its name and the controls that answer it", () => {
    expect(dialogs.map((d) => d.ref)).toEqual([
      "e2",
      "e8",
      "e12",
      "e16",
      "e20",
    ]);
    expect(byRef.get("e8")).toMatchObject({
      name: "Quota Exceeded",
      actions: [{ ref: "e11", label: "Dismiss" }],
    });
    // A nameless icon link is named by what it shows, as in the list.
    expect(byRef.get("e16")?.actions).toEqual([
      { ref: "e17", label: "Accept" },
      { ref: "e18", label: "Settings" },
    ]);
  });

  it("keeps a nested dialog's controls its own, its elements inside both", () => {
    expect(byRef.get("e20")?.actions).toEqual([{ ref: "e21", label: "Yes" }]);
    expect(byRef.get("e16")?.actions.map((a) => a.ref)).not.toContain("e21");
    expect(byRef.get("e16")?.refs.has("e21")).toBe(true);
    expect(byRef.get("e16")?.refs.has("e7")).toBe(false);
  });
});

describe("matchDialog", () => {
  const dialogs = dialogsIn(parseSnapshot(DIALOGS));
  const none = new Set<string>();

  it("pairs by name, and by the controls' labels when the name is the page's own heading", () => {
    expect(
      matchDialog(dialogs, { title: "Quota Exceeded", labels: [] }, none)?.ref,
    ).toBe("e8");
    expect(
      matchDialog(dialogs, { title: "Native", labels: ["Close"] }, none)?.ref,
    ).toBe("e12");
  });

  it("matches nothing rather than the wrong dialog", () => {
    expect(
      matchDialog(dialogs, { title: "Something else", labels: ["OK"] }, none),
    ).toBeUndefined();
  });

  it("pairs a modal that shows no controls with the one unnamed dialog, never a guess among two", () => {
    // A consent wall whose buttons live in its own iframe: the page sees
    // no controls, the tree prints the dialog with no name (spiegel.de).
    const wall = dialogsIn(
      parseSnapshot(`- dialog "Main menu" [ref=e2]:
  - link "Overview" [ref=e3]
- dialog [ref=e5]:
  - iframe [ref=e6]:
    - button "Consent and continue" [ref=f2e13]
`),
    );
    expect(
      matchDialog(wall, { title: "Privacy Center", labels: [] }, none)?.ref,
    ).toBe("e5");
    expect(
      matchDialog(
        wall,
        { title: "Privacy Center", labels: [] },
        new Set(["e5"]),
      ),
    ).toBeUndefined();
    // Two unnamed dialogs make the pick a guess, so there is none.
    const two = dialogsIn(
      parseSnapshot(`- dialog [ref=e1]:
  - button "A" [ref=e2]
- dialog [ref=e3]:
  - button "B" [ref=e4]
`),
    );
    expect(matchDialog(two, { title: "X", labels: [] }, none)).toBeUndefined();
    // A page that saw controls and matched none of them gets no fallback.
    expect(
      matchDialog(wall, { title: "X", labels: ["Nope"] }, none),
    ).toBeUndefined();
  });

  it("never pairs two open dialogs with one node", () => {
    expect(
      matchDialog(
        dialogs,
        { title: "Quota Exceeded", labels: ["Dismiss"] },
        new Set(["e8"]),
      ),
    ).toBeUndefined();
  });
});
