import { describe, expect, it } from "vitest";
import { formatReply, parseArgs, UsageError } from "./cli";

describe("onecli-browser argument parsing", () => {
  it("turns each verb's arguments into its request", () => {
    expect(parseArgs(["open", "https://example.com"])).toEqual({
      verb: "open",
      url: "https://example.com",
    });
    expect(parseArgs(["snapshot"])).toEqual({ verb: "snapshot", full: false });
    expect(parseArgs(["snapshot", "--full"])).toEqual({
      verb: "snapshot",
      full: true,
    });
    expect(parseArgs(["click", "e12"])).toEqual({
      verb: "click",
      target: { ref: "e12" },
    });
    expect(parseArgs(["type", "e3", "hello", "world"])).toEqual({
      verb: "type",
      target: { ref: "e3" },
      text: "hello world",
    });
    expect(parseArgs(["type", "e3", ""])).toEqual({
      verb: "type",
      target: { ref: "e3" },
      text: "",
    });
    expect(parseArgs(["press", "Enter"])).toEqual({
      verb: "press",
      key: "Enter",
    });
    expect(parseArgs(["select", "e4", "Oldest first"])).toEqual({
      verb: "select",
      target: { ref: "e4" },
      value: "Oldest first",
    });
    expect(parseArgs(["scroll"])).toEqual({
      verb: "scroll",
      direction: "down",
    });
    expect(parseArgs(["scroll", "up", "300"])).toEqual({
      verb: "scroll",
      direction: "up",
      pixels: 300,
    });
    expect(parseArgs(["scroll", "300"])).toEqual({
      verb: "scroll",
      direction: "down",
      pixels: 300,
    });
    // Shapes an agent guessed live; each would have silently scrolled down.
    for (const argv of [
      ["scroll", "--to", "top"],
      ["scroll", "-5000"],
      ["scroll", "top"],
      ["scroll", "down", "300", "px"],
    ]) {
      expect(() => parseArgs(argv)).toThrow("scroll takes [up|down] [px]");
    }
    expect(parseArgs(["screenshot"])).toEqual({ verb: "screenshot" });
    expect(parseArgs(["screenshot", "/tmp/a.png"])).toEqual({
      verb: "screenshot",
      path: "/tmp/a.png",
    });
    expect(parseArgs(["tab", "t2"])).toEqual({ verb: "tab", id: "t2" });
    expect(parseArgs(["tab-new"])).toEqual({ verb: "tab-new" });
    expect(parseArgs(["tab-new", "https://a.test"])).toEqual({
      verb: "tab-new",
      url: "https://a.test",
    });
    expect(parseArgs(["wait"])).toEqual({ verb: "wait" });
    expect(parseArgs(["wait", "--text", "Done"])).toEqual({
      verb: "wait",
      text: "Done",
    });
    expect(parseArgs(["wait", "--gone", "Testing"])).toEqual({
      verb: "wait",
      gone: "Testing",
    });
    expect(parseArgs(["wait", "--url", "**/inbox"])).toEqual({
      verb: "wait",
      url: "**/inbox",
    });
    expect(parseArgs(["wait", "--ms", "1500"])).toEqual({
      verb: "wait",
      ms: 1500,
    });
    expect(parseArgs(["eval", "document.title"])).toEqual({
      verb: "eval",
      js: "document.title",
    });
    for (const verb of [
      "back",
      "reload",
      "read",
      "tabs",
      "tab-close",
      "stop",
    ] as const) {
      expect(parseArgs([verb])).toEqual({ verb });
    }
  });

  it("takes an element by the role and name its line prints, the way a shell hands them over", () => {
    // `click button "Send now"`: the shell has taken the quotes, so the
    // name is one argument, spaces and all.
    expect(parseArgs(["click", "button", "Send now"])).toEqual({
      verb: "click",
      target: { role: "button", name: "Send now" },
    });
    expect(parseArgs(["hover", "link", "Docs"])).toEqual({
      verb: "hover",
      target: { role: "link", name: "Docs" },
    });
    expect(parseArgs(["type", "textbox", "Email", "a@b.c"])).toEqual({
      verb: "type",
      target: { role: "textbox", name: "Email" },
      text: "a@b.c",
    });
    expect(parseArgs(["type", "textbox", "Password", "-"])).toEqual({
      verb: "type",
      target: { role: "textbox", name: "Password" },
      text: "-",
    });
    expect(
      parseArgs(["select", "combobox", "Sort", "Oldest", "first"]),
    ).toEqual({
      verb: "select",
      target: { role: "combobox", name: "Sort" },
      value: "Oldest first",
    });
    // A frame-prefixed ref is a ref, not a role.
    expect(parseArgs(["click", "f2e15"])).toEqual({
      verb: "click",
      target: { ref: "f2e15" },
    });
  });

  it("refuses a name the shell split, a missing name, and a target that is neither form", () => {
    // Read as `button "Send"`, this would click a different button.
    expect(() => parseArgs(["click", "button", "Send", "now"])).toThrow(
      'quote the name: click button "Send now"',
    );
    expect(() => parseArgs(["click", "e3", "e4"])).toThrow(
      "click takes one ref",
    );
    for (const argv of [
      ["click", "button"],
      ["click", "button", ""],
      ["click", "Button", "Send"],
      ["click", "#send"],
      ["click", '"Send"'],
    ]) {
      expect(() => parseArgs(argv)).toThrow(
        'click needs a ref (e12) or a role and a name: click button "Send"',
      );
    }
    expect(() => parseArgs(["type", "textbox", "Email"])).toThrow(
      "type needs text",
    );
  });

  it("fails loudly on a missing argument or an unknown verb", () => {
    expect(() => parseArgs(["click"])).toThrow(UsageError);
    expect(() => parseArgs(["click"])).toThrow(
      "click needs a ref or a role and a name",
    );
    expect(() => parseArgs(["type", "e1"])).toThrow("type needs text");
    expect(() => parseArgs(["select", "e1"])).toThrow("select needs a value");
    expect(() => parseArgs(["frobnicate"])).toThrow("unknown verb: frobnicate");
    // `launch` is the command's own, handled before the parser; it is not a
    // request the daemon knows.
    expect(() => parseArgs(["launch"])).toThrow("unknown verb: launch");
  });

  it("treats no verb and help as a request for usage", () => {
    for (const argv of [[], ["help"], ["--help"], ["-h"]]) {
      try {
        parseArgs(argv);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        expect((error as UsageError).message).toBe("");
      }
    }
  });
});

describe("onecli-browser reply formatting", () => {
  it("prints the page header, then the element list", () => {
    expect(
      formatReply({
        ok: true,
        url: "https://a.test/",
        title: "A",
        snapshot: 'e1 link "Home"\ne2 button "Go"',
      }),
    ).toBe('url: https://a.test/\ntitle: A\n\ne1 link "Home"\ne2 button "Go"');
  });

  it("says so when the page has nothing to act on", () => {
    expect(
      formatReply({ ok: true, url: "u", title: "t", snapshot: "" }),
    ).toContain("(no interactive elements)");
  });

  it("prints a dialog the driver answered, before the page", () => {
    const out = formatReply({
      ok: true,
      url: "u",
      title: "t",
      dialog: "confirm: Leave?",
      snapshot: "",
    });
    expect(out.indexOf("dialog (answered): confirm: Leave?")).toBeLessThan(
      out.indexOf("(no interactive elements)"),
    );
  });

  it("leads with the page's modals and alerts, each control as the agent types it back", () => {
    const out = formatReply({
      ok: true,
      url: "u",
      title: "t",
      modals: [
        {
          title: "Quota Exceeded",
          text: "Try again tomorrow.",
          actions: [{ ref: "e10", label: "Dismiss" }],
        },
        { title: "Saving", text: "", actions: [{ label: "Cancel" }] },
      ],
      alerts: ["Settings saved"],
      snapshot: 'e2 button "Save"',
    });
    expect(out.split("\n").slice(2, 5)).toEqual([
      'modal "Quota Exceeded": Try again tomorrow. [e10 "Dismiss"]',
      'modal "Saving" ["Cancel"]',
      "alert: Settings saved",
    ]);
  });

  it("prints tabs with the active one starred", () => {
    const out = formatReply({
      ok: true,
      url: "u",
      title: "t",
      tabs: [
        { id: "t1", url: "https://a.test", title: "A", active: false },
        { id: "t2", url: "https://b.test", title: "", active: true },
      ],
    });
    expect(out).toContain("  t1  A  https://a.test");
    expect(out).toContain("* t2  (untitled)  https://b.test");
  });

  it("prints text, a saved path, and an eval value", () => {
    expect(
      formatReply({ ok: true, url: "u", title: "t", text: "body" }),
    ).toContain("\n\nbody");
    expect(
      formatReply({ ok: true, url: "u", title: "t", path: "/x.png" }),
    ).toContain("saved: /x.png");
    expect(
      formatReply({ ok: true, url: "u", title: "t", value: { a: 1 } }),
    ).toContain('"a": 1');
    expect(
      formatReply({ ok: true, url: "u", title: "t", value: null }),
    ).toContain("null");
  });

  it("prints ok for a reply with nothing else to say (stop)", () => {
    expect(formatReply({ ok: true, url: "", title: "" })).toBe("ok");
  });

  it("prints one error line for a failure", () => {
    expect(
      formatReply({ ok: false, error: "ref e9 is not in the last snapshot" }),
    ).toBe("error: ref e9 is not in the last snapshot");
  });
});
