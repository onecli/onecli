import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { hideThirdPartyFrames } from "./driver";
import { siteOf } from "./site";

/**
 * Every function the driver hands to `page.evaluate` is serialized from its
 * source and run in the page, where nothing of this module exists. A
 * transform that keeps function names (`keepNames`, which tsx turns on)
 * wraps every inner function in a module-scope `__name` helper, and the
 * page then throws `__name is not defined`; the `.catch` fallbacks around
 * those calls swallow it (observed: the iframe hide silently skipped, a
 * 5 s snapshot instead of 1). The production bundle does not keep names,
 * but the rule has to hold whatever builds the module: each page function
 * is transformed WITH keepNames here, serialized the way `page.evaluate`
 * does, and run in a bare context.
 */
const PAGE_FUNCTIONS = [
  "readPageState",
  "readMainText",
  "hideThirdPartyFrames",
  "restoreFrames",
  "waitForQuietDom",
] as const;

/** What each takes, as `page.evaluate` passes it. */
const ARGS: Partial<Record<(typeof PAGE_FUNCTIONS)[number], unknown[]>> = {
  readPageState: [[300, 3, 4]],
  hideThirdPartyFrames: ["example.com"],
  waitForQuietDom: [[300, 1500]],
};

const source = readFileSync(new URL("./driver.ts", import.meta.url), "utf8");

const keepNamesModule = () => {
  const { code } = transformSync(source, {
    loader: "ts",
    format: "cjs",
    keepNames: true,
    target: "node22",
  });
  const module = { exports: {} as Record<string, unknown> };
  const context = {
    module,
    exports: module.exports,
    require: (id: string) => {
      // The driver's own imports are not what is under test; stand them in.
      if (id === "patchright") return { chromium: {} };
      return {};
    },
    Object,
  };
  runInNewContext(code, context);
  return module.exports;
};

const bareContext = (args: unknown[]) => ({
  args,
  document: {
    title: "t",
    querySelectorAll: () => [],
    getElementById: () => null,
    documentElement: {},
    body: { innerText: "" },
    createElement: () => ({
      setAttribute() {},
      set textContent(_: string) {},
    }),
  },
  location: { hostname: "a.example.com", href: "https://a.example.com/" },
  URL,
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  setTimeout: (f: () => void) => {
    f();
    return 0;
  },
  clearTimeout: () => {},
  Promise,
});

/** A page with iframes, as hideThirdPartyFrames sees it, from a host and a list of frame srcs. */
const pageWithFrames = (pageHost: string, srcs: string[]) => {
  const frames = srcs.map((src) => {
    const attrs = new Map<string, string>(src ? [["src", src]] : []);
    return {
      getAttribute: (n: string) => attrs.get(n) ?? null,
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      marked: () => attrs.has("data-onecli-skip"),
    };
  });
  const sandbox = {
    document: {
      querySelectorAll: () => frames,
      documentElement: { appendChild() {} },
      createElement: () => ({
        set id(_: string) {},
        set textContent(_: string) {},
      }),
    },
    location: { hostname: pageHost, href: `https://${pageHost}/` },
    URL,
  };
  return {
    sandbox,
    hidden: () =>
      frames
        .filter((f) => f.marked())
        .map((f) => f.getAttribute("src") ?? "(src-less)"),
  };
};

describe("hideThirdPartyFrames", () => {
  // The rule itself is site.ts's (site.test.ts); this pins that the page
  // side applies it to each frame the same way, src-less frames included.
  const run = (pageHost: string, srcs: string[]) => {
    const page = pageWithFrames(pageHost, srcs);
    runInNewContext(
      `(${String(hideThirdPartyFrames)})(${JSON.stringify(siteOf(pageHost))})`,
      page.sandbox,
    );
    return page.hidden();
  };

  it("keeps the site's own frames and hides everyone else's", () => {
    expect(
      run("www.ynet.co.il", [
        "https://cz.ynet.co.il/Elections26/home/",
        "https://www.ynet.co.il/home/0,7340,L-8,00.html",
        "https://rep.erate.co.il/?t=if",
        "https://imprammp.taboola.com/st",
        "https://151bcfa0.safeframe.googlesyndication.com/safeframe/1-0-45/html/container.html",
        "",
        "about:blank",
      ]),
    ).toEqual([
      "https://rep.erate.co.il/?t=if",
      "https://imprammp.taboola.com/st",
      "https://151bcfa0.safeframe.googlesyndication.com/safeframe/1-0-45/html/container.html",
      "(src-less)",
      "about:blank",
    ]);
    expect(
      run("www.example.com", [
        "https://widgets.example.com/w",
        "https://example.com/embed",
        "https://evil-example.com/ad",
      ]),
    ).toEqual(["https://evil-example.com/ad"]);
  });
});

describe("the page-side functions", () => {
  const exported = keepNamesModule();

  it.each(PAGE_FUNCTIONS)(
    "%s runs from its serialized source under a name-keeping build",
    (name) => {
      const fn = exported[name];
      expect(typeof fn).toBe("function");
      const serialized = `(${String(fn)})(...args)`;
      // Every branch, not only the ones a bare page reaches: a helper the
      // transform wrapped anywhere in the body is a page-side ReferenceError.
      expect(serialized).not.toContain("__name");
      expect(() =>
        runInNewContext(serialized, bareContext(ARGS[name] ?? [])),
      ).not.toThrow();
    },
  );
});
