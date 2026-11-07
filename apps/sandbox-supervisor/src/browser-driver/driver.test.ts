import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "patchright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Driver } from "./driver";
import { DEVTOOLS_PORT } from "./launch";
import type { Reply } from "./protocol";

/**
 * The driver against a real browser. Runs where one is reachable: set
 * `ONECLI_BROWSER_TEST_EXECUTABLE` to a Chrome/Chromium binary, or have
 * Google Chrome installed at its macOS path. Skipped otherwise (CI).
 */
const EXECUTABLE =
  process.env.ONECLI_BROWSER_TEST_EXECUTABLE ??
  ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) =>
    existsSync(p),
  );

const PAGE = `<!doctype html><html><head><title>Driver test</title></head><body>
<h1>Hello</h1>
<a href="/second">Second page</a>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent ' + document.getElementById('name').value">
  <label>Name <input id="name" placeholder="your name"></label>
  <select id="pick"><option value="a">Alpha</option><option value="b">Beta</option></select>
  <button type="submit">Send</button>
</form>
<p id="out"></p>
<button id="later" onclick="setTimeout(() => { const b = document.createElement('button'); b.textContent = 'Appeared'; document.body.appendChild(b); }, 400)">Add later</button>
<button id="ask" onclick="document.getElementById('out').textContent = String(confirm('Sure?'))">Ask</button>
<a href="/second" target="_blank">Open in new tab</a>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second</title></head><body><h1>Second</h1><a href="/">Back home</a></body></html>`;

/** A news page: the first <article> in the DOM is a comment card, the story comes later. */
const STORY = `<!doctype html><html><head><title>Story</title></head><body>
<aside><article class="talkback"><p>First! Great piece.</p></article></aside>
<article class="story"><h1>Rain expected</h1><p>Forecasters expect rain across the north on Tuesday, the first of the season.</p><p>Drivers are asked to slow down.</p></article>
<footer><article class="teaser"><a href="/second">Also read: Second</a></article></footer>
</body></html>`;

/** The shape seen live: every <article> is a comment card, the story is a plain div. */
const COMMENTED = `<!doctype html><html><head><title>Commented</title></head><body>
<nav>Home News Sport</nav>
<div class="article-body"><h1>Rain expected</h1><p>Forecasters expect rain across the north on Tuesday, the first of the season. Reservoirs are at their lowest level in a decade and farmers have been waiting since the spring. The front is expected to reach the coast by the evening and move south overnight.</p></div>
<section class="comments">
<article class="comment"><p>First! Great piece.</p></article>
<article class="comment"><p>About time.</p></article>
</section>
</body></html>`;

/**
 * The Search Console shape: a side menu marked role=dialog that blocks
 * nothing, next to a closed dialog a library keeps mounted (aria-hidden,
 * full screen, invisible: the mui.com shape), and a button whose answer
 * arrives by fetch, first a "Testing" dialog, then the quota alertdialog
 * the page renders from the response.
 */
const CONSOLE = `<!doctype html><html><head><title>URL Inspection</title></head><body>
<nav role="dialog" aria-label="Main menu"><a href="#">Overview</a> <span aria-hidden="true">☰</span></nav>
<div aria-hidden="true" style="visibility:hidden;position:fixed;inset:0"></div>
<main><h1>URL Inspection</h1><button id="req">REQUEST INDEXING</button><a href="/second">Second page</a></main>
<div id="layer"></div>
<script>
document.getElementById('req').onclick = async () => {
  const layer = document.getElementById('layer');
  layer.innerHTML = '<div role="dialog" aria-modal="true" aria-label="Testing"><p>Testing if live URL can be indexed</p></div>';
  const answer = await (await fetch('/api/request')).json();
  layer.innerHTML =
    '<div style="position:fixed;inset:0;background:rgba(0,0,0,.4)"></div>' +
    '<div role="alertdialog" aria-modal="true" aria-labelledby="t" style="position:fixed;top:20%;left:20%;width:60%;background:#fff;padding:20px">' +
    '<div id="t">' + answer.title + '</div><p>' + answer.text + '</p>' +
    '<button onclick="document.getElementById(\\'layer\\').innerHTML = \\'\\'">Dismiss</button></div>';
};
</script></body></html>`;

/** Every other way a page says "this blocks you", and two ways it does not. */
const MODALS = `<!doctype html><html><head><title>Modals</title></head><body>
<div id="app"><h1>Settings</h1><input aria-label="Project name"><button id="save" onclick="document.getElementById('toast').textContent = 'Settings saved'">Save</button>
<button id="native" onclick="document.getElementById('d').showModal()">Native</button>
<button id="radix" onclick="document.getElementById('app').setAttribute('aria-hidden','true'); document.getElementById('r').hidden = false">Radix</button>
<button id="stack" onclick="document.getElementById('d').showModal(); document.getElementById('d2').showModal()">Stack</button></div>
<div role="alert" id="toast"></div>
<dialog id="d"><h2>Delete project?</h2><p>This cannot be undone.</p><button onclick="document.getElementById('d').close()">Cancel</button><button>Delete</button></dialog>
<dialog id="d2"><h2>Are you sure?</h2><button onclick="document.getElementById('d2').close()">No</button></dialog>
<div role="dialog" id="r" aria-labelledby="rt" hidden style="position:fixed;top:30%;left:30%;width:40%;background:#fff"><h2 id="rt">Invite people</h2><p>Add teammates by email.</p><button>Send invite</button></div>
<div role="dialog" aria-modal="true" aria-label="Not open" style="display:none"><button>Ghost</button></div>
<div role="dialog" aria-modal="true" aria-label="Parked drawer" style="position:fixed;top:0;left:-300px;width:300px;height:100%"><button>Parked</button></div>
<div role="dialog" aria-modal="false" aria-label="Cookie preferences" style="position:fixed;bottom:0;right:0;width:200px;height:100px"><button>Essential only</button></div>
<div aria-hidden="true" style="visibility:hidden;position:fixed;inset:0"><div role="dialog">Closed but mounted</div></div>
<div role="dialog" id="nameless" aria-modal="true" hidden style="position:fixed;top:10%;left:10%;width:30%;background:#fff"><button>Inbox</button></div>
<button id="menu" style="position:fixed;bottom:0;left:0" onclick="document.getElementById('nameless').hidden = false">Menu</button>
</body></html>`;

/**
 * A list with one button per row under the same name, a search field, and
 * a confirm dialog whose Cancel has a twin on the page behind it: the
 * shapes where naming an element by role and name must refuse, or must
 * pick the one the dialog holds.
 */
const ROWS = `<!doctype html><html><head><title>Rows</title></head><body>
<h1>Projects</h1>
<input type="search" aria-label="Find a project">
<ul><li>Alpha <button onclick="document.getElementById('d').showModal()">Delete</button></li>
<li>Beta <button onclick="document.getElementById('d').showModal()">Delete</button></li></ul>
<button onclick="document.getElementById('out').textContent = 'page cancel'">Cancel</button>
<a href="/rows">Reload the list</a>
<p id="out"></p>
<dialog id="d"><h2>Delete the project?</h2><button onclick="document.getElementById('out').textContent = 'dialog cancel'; document.getElementById('d').close()">Cancel</button></dialog>
</body></html>`;

const ok = (reply: Reply): Extract<Reply, { ok: true }> => {
  if (!reply.ok) throw new Error(`expected ok, got: ${reply.error}`);
  return reply;
};
const refOf = (snapshot: string | undefined, label: string): string => {
  const line = snapshot?.split("\n").find((l) => l.includes(label));
  if (!line) throw new Error(`no element ${label} in:\n${snapshot ?? ""}`);
  return line.split(" ")[0] ?? "";
};

describe.skipIf(!EXECUTABLE)("Driver (real browser)", () => {
  let server: Server;
  let origin = "";
  let browser: Browser;
  let driver: Driver;
  let dir: string;

  beforeAll(async () => {
    let checks = 0;
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/checked") {
        // A bot check that clears on its own: two interstitials, then the page.
        checks += 1;
        if (checks <= 2) {
          res.end(
            `<title>Just a moment...</title><h1>Performing security verification</h1><script>setTimeout(() => location.reload(), 700)</script>`,
          );
          return;
        }
        res.end(
          `<title>Through</title><h1>Welcome through</h1><a href="/">Home</a>`,
        );
        return;
      }
      if (req.url === "/walled") {
        // A vendor interstitial frame on an empty page, never clearing.
        res.end(
          `<title>example</title><body><iframe src="https://geo.captcha-delivery.com/interstitial/?x=1"></iframe></body>`,
        );
        return;
      }
      if (req.url === "/story") {
        res.end(STORY);
        return;
      }
      if (req.url === "/commented") {
        res.end(COMMENTED);
        return;
      }
      if (req.url === "/console") {
        res.end(CONSOLE);
        return;
      }
      if (req.url === "/modals") {
        res.end(MODALS);
        return;
      }
      if (req.url === "/api/request") {
        // Answered after a beat, like the real check: the dialog the page
        // renders from this must be in the click's own reply.
        setTimeout(() => {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              title: "Quota Exceeded",
              text: "Sorry, you have exceeded your daily quota. Please try again tomorrow.",
            }),
          );
        }, 600);
        return;
      }
      if (req.url === "/rows") {
        res.end(ROWS);
        return;
      }
      res.end(req.url === "/second" ? SECOND : PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    origin = `http://127.0.0.1:${String(address.port)}`;
    dir = mkdtempSync(join(tmpdir(), "onecli-driver-"));
    // A headless browser on the driver's port: launchBrowser() sees it
    // listening and attaches instead of spawning the sandbox's binary.
    browser = await chromium.launch({
      executablePath: EXECUTABLE,
      headless: true,
      args: [`--remote-debugging-port=${String(DEVTOOLS_PORT)}`],
    });
    driver = new Driver({
      environment: {
        display: undefined,
        proxy: undefined,
        homeDir: dir,
        lang: undefined,
      },
      outputDir: dir,
    });
  }, 60_000);

  // Each test starts on one tab: the one before may have opened more.
  beforeEach(async () => {
    ok(await driver.handle({ verb: "open", url: "about:blank" }));
    let tabs = ok(await driver.handle({ verb: "tabs" })).tabs ?? [];
    while (tabs.length > 1) {
      ok(await driver.handle({ verb: "tab-close" }));
      tabs = ok(await driver.handle({ verb: "tabs" })).tabs ?? [];
    }
  });

  afterAll(async () => {
    await driver.close();
    await browser.close();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("opens a page and lists what can be acted on, with refs", async () => {
    const reply = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    expect(reply.title).toBe("Driver test");
    expect(reply.snapshot).toContain('heading "Hello" [level=1]');
    expect(reply.snapshot).toContain('link "Second page"');
    expect(reply.snapshot).toContain('textbox "Name"');
    expect(reply.snapshot).toContain('button "Send"');
    expect(reply.snapshot).not.toContain("paragraph");
  });

  it("types into a field and clicks a button, then shows the page after", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const name = refOf(page.snapshot, 'textbox "Name"');
    const send = refOf(page.snapshot, 'button "Send"');
    ok(
      await driver.handle({
        verb: "type",
        target: { ref: name },
        text: "Alex",
      }),
    );
    ok(await driver.handle({ verb: "click", target: { ref: send } }));
    const text = ok(await driver.handle({ verb: "read" }));
    expect(text.text).toContain("sent Alex");
  });

  it("reads the story, not the first article-shaped comment card", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/story` }));
    const text = ok(await driver.handle({ verb: "read" }));
    expect(text.text).toContain("Forecasters expect rain");
    expect(text.text).not.toContain("Great piece");
    expect(text.text).not.toContain("Also read");
  });

  it("reads the whole page when every <article> is a comment card", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/commented` }));
    const text = ok(await driver.handle({ verb: "read" }));
    expect(text.text).toContain("Forecasters expect rain");
    expect(text.text).toContain("Rain expected");
  });

  it("does not call a side menu marked role=dialog a modal", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    expect(page.modals).toBeUndefined();
    expect(page.snapshot).toContain('button "REQUEST INDEXING"');
  });

  it("puts the dialog a fetch answered in the click's own reply, with the refs that answer it", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    const reply = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"REQUEST INDEXING"') },
      }),
    );
    expect(reply.modals).toHaveLength(1);
    const [modal] = reply.modals ?? [];
    expect(modal?.title).toBe("Quota Exceeded");
    expect(modal?.text).toContain("exceeded your daily quota");
    expect(modal?.text).not.toContain("Dismiss");
    expect(modal?.actions).toEqual([
      { ref: refOf(reply.snapshot, 'button "Dismiss"'), label: "Dismiss" },
    ]);
  });

  it("refuses an element behind a modal in seconds, naming the way out", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    const opened = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"REQUEST INDEXING"') },
      }),
    );
    const behind = refOf(opened.snapshot, 'link "Second page"');
    const dismiss = refOf(opened.snapshot, 'button "Dismiss"');
    const t = Date.now();
    const refused = await driver.handle({
      verb: "click",
      target: { ref: behind },
    });
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(refused).toEqual({
      ok: false,
      error: `${behind} is behind the open dialog "Quota Exceeded"; answer it first: ${dismiss} "Dismiss"`,
    });
    // The modal's own control is reachable, and answering it clears the way.
    const after = ok(
      await driver.handle({ verb: "click", target: { ref: dismiss } }),
    );
    expect(after.modals).toBeUndefined();
    ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(after.snapshot, 'link "Second page"') },
      }),
    );
  }, 15_000);

  it("waits a progress dialog out with wait --gone, and for words with --text, past a hidden copy", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/console` }));
    ok(
      await driver.handle({
        verb: "eval",
        js: `document.getElementById('layer').innerHTML = '<p hidden>Testing if live URL can be indexed</p><div role="dialog" aria-modal="true" aria-label="Testing"><p>Testing if live URL can be indexed</p></div>'; setTimeout(() => { document.getElementById('layer').lastChild.remove(); document.body.insertAdjacentHTML('beforeend', '<p>Indexing requested</p>'); }, 1500); true`,
      }),
    );
    const t = Date.now();
    const reply = ok(
      await driver.handle({ verb: "wait", gone: "Testing if live URL" }),
    );
    expect(Date.now() - t).toBeGreaterThan(800);
    expect(reply.modals).toBeUndefined();

    ok(
      await driver.handle({
        verb: "eval",
        js: `document.body.insertAdjacentHTML('afterbegin', '<p hidden>Saved at noon</p>'); setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<p>Saved at noon</p>'), 500); true`,
      }),
    );
    ok(await driver.handle({ verb: "wait", text: "Saved at noon" }));
  });

  it("reports a native modal and refuses a click or a fill behind it", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/modals` }),
    );
    expect(page.modals).toBeUndefined();

    const native = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Native"') },
      }),
    );
    expect(native.modals?.map((m) => [m.title, m.text])).toEqual([
      ["Delete project?", "This cannot be undone."],
    ]);
    expect(native.modals?.[0]?.actions.map((a) => a.label)).toEqual([
      "Cancel",
      "Delete",
    ]);
    const refused = await driver.handle({
      verb: "click",
      target: { ref: refOf(native.snapshot, 'button "Save"') },
    });
    expect(refused.ok ? "" : refused.error).toContain(
      'is behind the open dialog "Delete project?"',
    );
    // fill never asks whether a pointer reaches the field: without the
    // check it would take the text behind the modal and report success.
    const typed = await driver.handle({
      verb: "type",
      target: { ref: refOf(native.snapshot, 'textbox "Project name"') },
      text: "x",
    });
    expect(typed.ok ? "" : typed.error).toContain(
      'is behind the open dialog "Delete project?"',
    );
    expect(
      ok(
        await driver.handle({
          verb: "eval",
          js: "document.querySelector('input').value",
        }),
      ).value,
    ).toBe("");
    const closed = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(native.snapshot, 'button "Cancel"') },
      }),
    );
    expect(closed.modals).toBeUndefined();
  }, 15_000);

  it("lists stacked modals topmost first", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/modals` }),
    );
    const stacked = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Stack"') },
      }),
    );
    expect(stacked.modals?.map((m) => m.title)).toEqual([
      "Are you sure?",
      "Delete project?",
    ]);
  });

  it("reports a dialog the page made modal by hiding the rest, never a hidden one", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/modals` }),
    );
    // Kept mounted but not open: a drawer parked off screen, a consent box
    // its author marked aria-modal=false, a closed dialog whose aria-hidden
    // wrapper is invisible (observed on mui.com: reported on every reply).
    expect(page.modals).toBeUndefined();
    const radix = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Radix"') },
      }),
    );
    expect(radix.modals?.map((m) => m.title)).toEqual(["Invite people"]);
    expect(JSON.stringify(radix)).not.toContain("Ghost");
  });

  it("names a modal that names itself nowhere", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/modals` }),
    );
    const menu = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Menu"') },
      }),
    );
    expect(menu.modals?.map((m) => m.title)).toEqual(["(untitled)"]);
    expect(menu.modals?.[0]?.actions.map((a) => a.label)).toEqual(["Inbox"]);
  });

  it("reports what the page announced in role=alert", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/modals` }),
    );
    expect(page.alerts).toBeUndefined();
    const saved = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Save"') },
      }),
    );
    expect(saved.alerts).toEqual(["Settings saved"]);
  });

  it("names an open modal on replies that print no element list", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"REQUEST INDEXING"') },
      }),
    );
    const read = ok(await driver.handle({ verb: "read" }));
    expect(read.modals).toEqual([
      {
        title: "Quota Exceeded",
        text: "Sorry, you have exceeded your daily quota. Please try again tomorrow.",
        actions: [{ label: "Dismiss" }],
      },
    ]);
  });

  it("refuses a ref the last snapshot did not print", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const reply = await driver.handle({
      verb: "click",
      target: { ref: "e999" },
    });
    expect(reply).toEqual({
      ok: false,
      error:
        "ref e999 is not in the last snapshot of this tab; take a new snapshot",
    });
  });

  it("acts on an element by its role and name, the same one across page loads", async () => {
    // The loop a script runs: open, then the same steps on each page, with
    // no ref cut out of the reply in between.
    for (const n of [1, 2, 3]) {
      ok(
        await driver.handle({ verb: "open", url: `${origin}/?n=${String(n)}` }),
      );
      ok(
        await driver.handle({
          verb: "type",
          target: { role: "textbox", name: "Name" },
          text: `Alex ${String(n)}`,
        }),
      );
      ok(
        await driver.handle({
          verb: "click",
          target: { role: "button", name: "Send" },
        }),
      );
      const text = ok(await driver.handle({ verb: "read" }));
      expect(text.text).toContain(`sent Alex ${String(n)}`);
    }
  });

  it("after a page load, says what a stale ref was and what it is now, and does not act", async () => {
    const first = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    const old = refOf(first.snapshot, 'button "REQUEST INDEXING"');
    // The same page, opened again: a new document, so new refs.
    const second = ok(
      await driver.handle({ verb: "open", url: `${origin}/console` }),
    );
    const now = refOf(second.snapshot, 'button "REQUEST INDEXING"');
    expect(now).not.toBe(old);
    // Looking again at the new page is not a new page: the old one is
    // still what a stale ref is explained from.
    ok(await driver.handle({ verb: "snapshot" }));
    expect(
      await driver.handle({ verb: "click", target: { ref: old } }),
    ).toEqual({
      ok: false,
      error: `ref ${old} is not in the last snapshot of this tab; it was button "REQUEST INDEXING", now ${now} (or name it: button "REQUEST INDEXING")`,
    });
    // Nothing was clicked: no Testing dialog came up.
    expect(
      ok(await driver.handle({ verb: "snapshot" })).modals,
    ).toBeUndefined();
  });

  it("refuses a name two elements share, and names what is close when none matches", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/rows` }),
    );
    const deletes = (page.snapshot ?? "")
      .split("\n")
      .filter((l) => l.endsWith('button "Delete"'))
      .map((l) => l.split(" ")[0]);
    expect(deletes).toHaveLength(2);
    expect(
      await driver.handle({
        verb: "click",
        target: { role: "button", name: "Delete" },
      }),
    ).toEqual({
      ok: false,
      error: `button "Delete" matches 2 elements: ${deletes.join(", ")}; use the ref of the one you mean`,
    });
    const reload = refOf(page.snapshot, 'link "Reload the list"');
    expect(
      await driver.handle({
        verb: "click",
        target: { role: "button", name: "Reload the list" },
      }),
    ).toEqual({
      ok: false,
      error: `no button "Reload the list" in the last snapshot of this tab; close: ${reload} link "Reload the list"`,
    });
    // Neither click happened.
    expect(
      ok(await driver.handle({ verb: "snapshot" })).modals,
    ).toBeUndefined();
  });

  it("takes the dialog's own control when its name has a twin behind the dialog", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/rows` }),
    );
    const opened = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Delete"') },
      }),
    );
    expect(opened.modals?.[0]?.title).toBe("Delete the project?");
    ok(
      await driver.handle({
        verb: "click",
        target: { role: "button", name: "Cancel" },
      }),
    );
    const text = ok(await driver.handle({ verb: "read" }));
    expect(text.text).toContain("dialog cancel");
  });

  it("refuses a named element behind an open modal by the name it was given", async () => {
    const page = ok(
      await driver.handle({ verb: "open", url: `${origin}/rows` }),
    );
    ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, 'button "Delete"') },
      }),
    );
    const refused = await driver.handle({
      verb: "type",
      target: { role: "searchbox", name: "Find a project" },
      text: "x",
    });
    expect(refused.ok ? "" : refused.error).toMatch(
      /^searchbox "Find a project" is behind the open dialog "Delete the project\?"; answer it first: /,
    );
  }, 15_000);

  it("follows a link and waits for the new page before answering", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const after = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"Second page"') },
      }),
    );
    expect(after.url).toBe(`${origin}/second`);
    expect(after.title).toBe("Second");
    expect(after.snapshot).toContain('link "Back home"');
    const back = ok(await driver.handle({ verb: "back" }));
    expect(back.title).toBe("Driver test");
  });

  it("waits for the DOM to settle after an action that changes it late", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const after = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"Add later"') },
      }),
    );
    expect(after.snapshot).toContain('button "Appeared"');
  });

  it("answers a confirm dialog and reports it once", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const after = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"Ask"') },
      }),
    );
    expect(after.dialog).toBe("confirm: Sure?");
    const text = ok(await driver.handle({ verb: "read" }));
    expect(text.text).toContain("false"); // dismissed
    expect(text.dialog).toBeUndefined();
  });

  it("selects an option and evaluates JavaScript", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    ok(
      await driver.handle({
        verb: "select",
        target: { ref: refOf(page.snapshot, "combobox") },
        value: "Beta",
      }),
    );
    const value = ok(
      await driver.handle({
        verb: "eval",
        js: "document.getElementById('pick').value",
      }),
    );
    expect(value.value).toBe("b");
    expect(
      ok(await driver.handle({ verb: "eval", js: "undefined" })).value,
    ).toBeNull();
    expect(
      ok(await driver.handle({ verb: "eval", js: "({ a: [1, 'x'] })" })).value,
    ).toEqual({ a: [1, "x"] });
  });

  it("lists, switches, and closes tabs", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const fresh = ok(
      await driver.handle({ verb: "tab-new", url: `${origin}/second` }),
    );
    expect(fresh.title).toBe("Second");
    const tabs = ok(await driver.handle({ verb: "tabs" })).tabs ?? [];
    expect(tabs.filter((t) => t.active)).toHaveLength(1);
    expect(tabs.find((t) => t.active)?.title).toBe("Second");
    const other = tabs.find((t) => !t.active);
    if (!other) throw new Error("expected two tabs");
    expect(ok(await driver.handle({ verb: "tab", id: other.id })).title).toBe(
      "Driver test",
    );
    ok(await driver.handle({ verb: "tab-close" }));
    const left = ok(await driver.handle({ verb: "tabs" })).tabs ?? [];
    expect(left).toHaveLength(1);
    expect(await driver.handle({ verb: "tab", id: "t99" })).toEqual({
      ok: false,
      error: "no tab t99; run tabs to list them",
    });
  });

  it("follows a tab the page opens, and tabs lists both", async () => {
    const page = ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const popup = ok(
      await driver.handle({
        verb: "click",
        target: { ref: refOf(page.snapshot, '"Open in new tab"') },
      }),
    );
    expect(popup.title).toBe("Second");
    const tabs = ok(await driver.handle({ verb: "tabs" })).tabs ?? [];
    expect(tabs.map((t) => t.title).sort()).toEqual(["Driver test", "Second"]);
    expect(tabs.find((t) => t.active)?.title).toBe("Second");
  });

  it("waits a bot check out and answers with the real page in one call", async () => {
    const t = Date.now();
    const reply = ok(
      await driver.handle({ verb: "open", url: `${origin}/checked` }),
    );
    expect(reply.title).toBe("Through");
    expect(reply.challenge).toBeUndefined();
    expect(reply.snapshot).toContain('link "Home"');
    expect(Date.now() - t).toBeLessThan(15_000);
  });

  it("names a bot check that does not clear, so the agent stops instead of retrying", async () => {
    const reply = ok(
      await driver.handle({ verb: "open", url: `${origin}/walled` }),
    );
    expect(reply.challenge).toBe(true);
  }, 40_000);

  it("reattaches on a dead target and runs the verb again", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    // Kill the attachment under the driver the way a crashed renderer or a
    // dropped CDP session does; the next verb must still answer.
    const live = (driver as unknown as { browser: Browser | null }).browser;
    await live?.close();
    const reply = ok(
      await driver.handle({ verb: "open", url: `${origin}/second` }),
    );
    expect(reply.title).toBe("Second");
  });

  it("takes a screenshot where asked", async () => {
    ok(await driver.handle({ verb: "open", url: `${origin}/` }));
    const path = join(dir, "shot.png");
    const reply = ok(await driver.handle({ verb: "screenshot", path }));
    expect(reply.path).toBe(path);
    expect(existsSync(path)).toBe(true);
  });

  it("turns a failed navigation into one short error line", async () => {
    // A port nothing listens on: bind one, read it, release it.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const address = probe.address();
    const closedPort =
      address && typeof address !== "string" ? address.port : 0;
    await new Promise<void>((r) => probe.close(() => r()));
    const reply = await driver.handle({
      verb: "open",
      url: `http://127.0.0.1:${String(closedPort)}/`,
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error).toMatch(/ERR_CONNECTION_REFUSED/);
      expect(reply.error).not.toContain("\n");
    }
  });
});
