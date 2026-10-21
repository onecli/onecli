import { describe, expect, it } from "vitest";
import {
  describeTarget,
  ElementIndex,
  resolveTarget,
  type Element,
} from "./target";

const el = (ref: string, role: string, name: string): Element => ({
  ref,
  role,
  name,
});

/** A page as the element list prints it: a form, two Deletes, a frame. */
const PAGE = new ElementIndex([
  el("e3", "link", "Home"),
  el("e7", "textbox", "Email"),
  el("e8", "button", "Send now"),
  el("e9", "button", "Delete"),
  el("e10", "button", "Delete"),
  el("e11", "link", "Sign in"),
  el("e12", "link", ""),
  el("f1e2", "button", "In frame"),
]);

describe("ElementIndex", () => {
  it("knows which page it is of, by the load sequence on its top document's refs", () => {
    expect(PAGE.document).toBe("");
    expect(
      new ElementIndex([el("f3e1", "link", "a"), el("f4e2", "button", "b")])
        .document,
    ).toBe("f3");
    expect(new ElementIndex([]).document).toBe("");
  });
});

describe("describeTarget", () => {
  it("spells a target the way the agent types it", () => {
    expect(describeTarget({ ref: "f1e8" })).toBe("f1e8");
    expect(describeTarget({ role: "button", name: "Send now" })).toBe(
      'button "Send now"',
    );
  });
});

describe("resolveTarget by role and name", () => {
  it("names the one element with exactly that role and name, in a frame too", () => {
    expect(resolveTarget({ role: "button", name: "Send now" }, PAGE)).toEqual({
      ref: "e8",
    });
    expect(resolveTarget({ role: "button", name: "In frame" }, PAGE)).toEqual({
      ref: "f1e2",
    });
  });

  it("never guesses between two: it lists their refs", () => {
    expect(resolveTarget({ role: "button", name: "Delete" }, PAGE)).toEqual({
      error:
        'button "Delete" matches 2 elements: e9, e10; use the ref of the one you mean',
    });
  });

  it("takes the one inside the open modal when the others are behind it", () => {
    expect(
      resolveTarget({ role: "button", name: "Delete" }, PAGE, {
        within: new Set(["e10"]),
      }),
    ).toEqual({ ref: "e10" });
    // Both inside: still a guess, still refused.
    expect(
      "error" in
        resolveTarget({ role: "button", name: "Delete" }, PAGE, {
          within: new Set(["e9", "e10"]),
        }),
    ).toBe(true);
  });

  it("matches exactly: no case folding, no partial names, no trimming", () => {
    for (const name of ["send now", "Send", "Send now "]) {
      expect("error" in resolveTarget({ role: "button", name }, PAGE)).toBe(
        true,
      );
    }
  });

  it("suggests the same name under its real role first", () => {
    expect(resolveTarget({ role: "button", name: "Sign in" }, PAGE)).toEqual({
      error:
        'no button "Sign in" in the last snapshot of this tab; close: e11 link "Sign in"',
    });
  });

  it("else suggests names of that role that contain it, or that it contains", () => {
    expect(resolveTarget({ role: "button", name: "send" }, PAGE)).toEqual({
      error:
        'no button "send" in the last snapshot of this tab; close: e8 button "Send now"',
    });
    expect(
      resolveTarget({ role: "button", name: "Delete everything" }, PAGE),
    ).toEqual({
      error:
        'no button "Delete everything" in the last snapshot of this tab; close: e9 button "Delete", e10 button "Delete"',
    });
  });

  it("says how to find the name when nothing is close", () => {
    expect(resolveTarget({ role: "checkbox", name: "Agree" }, PAGE)).toEqual({
      error:
        'no checkbox "Agree" in the last snapshot of this tab; take a new snapshot and use a name exactly as a line shows it',
    });
  });

  it("caps a long list of refs", () => {
    const many = new ElementIndex(
      Array.from({ length: 8 }, (_, i) => el(`e${String(i)}`, "link", "More")),
    );
    expect(resolveTarget({ role: "link", name: "More" }, many)).toEqual({
      error:
        'link "More" matches 8 elements: e0, e1, e2, e3, e4, \u2026; use the ref of the one you mean (the element list shows all of them)',
    });
  });
});

describe("resolveTarget by ref", () => {
  it("names the element the ref is, and nothing else", () => {
    expect(resolveTarget({ ref: "e7" }, PAGE)).toEqual({ ref: "e7" });
    expect(resolveTarget({ ref: "e99" }, PAGE)).toEqual({
      error:
        "ref e99 is not in the last snapshot of this tab; take a new snapshot",
    });
  });

  it("after a page change, says what a stale ref was and what it is now, without acting on it", () => {
    // The live failure: e8 on the first page, f1e8 after the next open.
    const before = new ElementIndex([el("e8", "button", "REQUEST INDEXING")]);
    const after = new ElementIndex([
      el("f1e8", "button", "REQUEST INDEXING"),
      el("f1e9", "link", "Overview"),
    ]);
    expect(resolveTarget({ ref: "e8" }, after, { previous: before })).toEqual({
      error:
        'ref e8 is not in the last snapshot of this tab; it was button "REQUEST INDEXING", now f1e8 (or name it: button "REQUEST INDEXING")',
    });
  });

  it("does not point a stale ref at a guess", () => {
    const before = new ElementIndex([
      el("e9", "button", "Delete"),
      el("e12", "link", ""),
    ]);
    // Two Deletes now: which one the old ref was is not knowable.
    const reloaded = new ElementIndex([
      el("f1e9", "button", "Delete"),
      el("f1e10", "button", "Delete"),
    ]);
    expect(
      resolveTarget({ ref: "e9" }, reloaded, { previous: before }),
    ).toEqual({
      error:
        'ref e9 is not in the last snapshot of this tab; it was button "Delete"; take a new snapshot',
    });
    // A nameless element has nothing to find it by.
    expect(
      resolveTarget({ ref: "e12" }, new ElementIndex([]), { previous: before }),
    ).toEqual({
      error:
        "ref e12 is not in the last snapshot of this tab; take a new snapshot",
    });
  });
});
