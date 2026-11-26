import { spawn } from "node:child_process";
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Reply, Request } from "./protocol";
import { GET_PROPERTIES, isGetProperty } from "./get-property";
import { describeAction } from "./modal-action";
import { REF, ROLE, type Target } from "./target";
import { isReply } from "./reply";
import { environmentFromEnv, launchBrowser } from "./launch";
import { agentHomeDir, browserSocketPath } from "./paths";
import { withLoopbackUnproxied } from "./proxy-env";

/**
 * `onecli-browser <verb> [args]`: the one command an agent runs to use the
 * browser. Parses the verb, sends it to the daemon (starting one if none
 * answers), prints the reply as plain text. Exit 0 on `ok`, 1 otherwise.
 *
 * No library loads here beyond node's own: this process is the per-call
 * cost, so it stays a socket round-trip.
 */

/**
 * How long a freshly spawned daemon may take to open its socket. Only the
 * process start and the library load: the daemon listens first and
 * launches the browser inside the first verb, so the launch is covered by
 * REPLY_TIMEOUT_MS below. A daemon that is not listening by then is not
 * coming (the agent sees the launch error through the next call's log).
 */
const SPAWN_WAIT_MS = 15_000;
/**
 * The longest one verb may take end to end before the command gives up:
 * past the driver's own VERB_DEADLINE_MS, so the driver's one-line answer
 * ("the page did not answer; reattached") reaches the agent instead of
 * this blunter one.
 */
const REPLY_TIMEOUT_MS = 90_000;

export const USAGE = `usage: onecli-browser <verb> [args]

  open <url>              go to a page; prints its elements
  snapshot [--full] [<el>] the current page's elements (refs like e12); --full
                          adds third-party frames (payment fields, widgets);
                          <el> keeps to that element's subtree (a form, a table)
  click <el>              click an element from the last snapshot
  type <el> <text>        replace a field's text ("" clears; "-" reads stdin,
                          for a password: type e7 - < secret.txt); refused
                          if the field reads something else afterwards
  press <key>             a key: Enter, Tab, Escape, ArrowDown, Control+a
  select <el> <value>     pick a <select> option by value or label
  check <el> | uncheck <el>  set a checkbox or switch (no-op if already so)
  upload <el> <file>...   put files from your home on a file field or button
  hover <el>              hover an element (opens menus)
  get text|value|href <el>  one thing about an element, as plain text
                          (a password field's value is never read back)
  scroll [up|down] [px]   scroll the page (default down 600)
  back | reload           history back; reload the page
  read                    the page's readable text
  screenshot [--full] [path]  a PNG (--full: the whole page); prints where it landed
  wait [--text T|--gone T|--url U|--ms N]   wait for text to show, for text
                          to leave (a "Testing…" dialog closing), a URL
                          (globs: **/done), time, or the page to settle;
                          prints the page after
  tabs | tab <id> | tab-new [url] | tab-close
  eval <js>               run JavaScript in the page; prints its JSON result
  dialog accept [text] | dialog dismiss   answer the confirm or prompt the
                          page is stopped on
  launch                  start the browser without touching a page
  stop                    end the background driver (the browser stays)

Each verb that changes the page prints the page afterwards: url, title,
then one line per element you can act on: "<ref> <role> \\"<name>\\"".
<el> is a ref from that list (e12), good until the next printout, or the
role and name as the line prints them (button "Send"), which hold across
page loads: use the ref right after reading a reply, the name in a script.
A name two elements share is refused with their refs.
A dialog blocking the page comes first, as a modal line: its title, what
it says, and the controls that answer it. Read it before anything else;
an action outside it is refused until it is answered. An alert line is
what the page announced (a saved notice, a form error). A confirm or a
prompt the page raised ("Delete everything?") comes as a dialog line and
stops the page: answer it with dialog accept or dialog dismiss first.
open waits for the page to load and settle, and waits out a site's bot
check (up to 20 s) before printing; a reply that says "bot check" means
it did not clear and a person has to. Never add sleeps or retries.
Exit 0 on success, 1 on any error (the first line of output says which).`;

export class UsageError extends Error {}

/** argv (after the command name) → one request. */
export const parseArgs = (argv: readonly string[]): Request => {
  const [verb, ...given] = argv;
  // `get` names its property before the element; the target grammar below
  // reads from `rest`, so that one verb strips the property off first.
  const rest = verb === "get" ? given.slice(1) : given;
  const need = (n: number, what: string): string[] => {
    if (rest.length < n) throw new UsageError(`${verb ?? ""} needs ${what}`);
    return rest;
  };
  /**
   * The element a verb acts on, at the head of its arguments, and what
   * follows it: a ref (`e12`), or a role and its name as the line prints
   * them (`button "Send now"`: the shell has already taken the quotes, so
   * the name is one argument). `exact` verbs take nothing after it: a
   * name the shell split (`click button Send now`) is refused, not read as
   * `button "Send"`.
   */
  const target = (
    exact: boolean,
  ): { target: Target; after: readonly string[] } => {
    const [head, name, ...after] = rest;
    if (head === undefined)
      throw new UsageError(`${verb ?? ""} needs a ref or a role and a name`);
    if (REF.test(head)) {
      const tail = rest.slice(1);
      if (exact && tail.length > 0)
        throw new UsageError(`${verb ?? ""} takes one ref`);
      return { target: { ref: head }, after: tail };
    }
    if (!ROLE.test(head) || name === undefined || name === "")
      throw new UsageError(
        `${verb ?? ""} needs a ref (e12) or a role and a name: ${verb ?? ""} button "Send"`,
      );
    if (exact && after.length > 0)
      throw new UsageError(
        `quote the name: ${verb ?? ""} ${head} "${[name, ...after].join(" ")}"`,
      );
    return { target: { role: head, name }, after };
  };
  /** What a verb that also takes a value (`type`, `select`) was given after its target. */
  const value = (after: readonly string[], what: string): string => {
    if (after.length === 0) throw new UsageError(`${verb ?? ""} needs ${what}`);
    return after.join(" ");
  };
  switch (verb) {
    case "open":
      return { verb, url: need(1, "a url")[0] ?? "" };
    case "snapshot": {
      // `snapshot`, `snapshot --full`, `snapshot e12`, `snapshot --full form "Sign up"`.
      const full = rest.includes("--full");
      const scope = rest.filter((a) => a !== "--full");
      if (scope.length === 0) return { verb, full };
      const [head, name, ...after] = scope;
      if (head !== undefined && REF.test(head) && scope.length === 1)
        return { verb, full, within: { ref: head } };
      if (
        head !== undefined &&
        ROLE.test(head) &&
        name !== undefined &&
        name !== "" &&
        after.length === 0
      )
        return { verb, full, within: { role: head, name } };
      throw new UsageError(
        'snapshot takes [--full] and at most one element: snapshot e12, or snapshot form "Sign up"',
      );
    }
    case "click":
    case "hover":
    case "check":
    case "uncheck":
      return { verb, target: target(true).target };
    case "type": {
      const { target: on, after } = target(false);
      return { verb, target: on, text: value(after, "text") };
    }
    case "select": {
      const { target: on, after } = target(false);
      return { verb, target: on, value: value(after, "a value") };
    }
    case "upload": {
      const { target: on, after } = target(false);
      if (after.length === 0) throw new UsageError("upload needs a file path");
      // Resolved here, against the shell's working directory: the daemon is
      // a background process whose cwd is nobody's, and `upload e5 report.pdf`
      // means the file next to the agent. Containment is the daemon's.
      return { verb, target: on, paths: after.map((p) => resolve(p)) };
    }
    case "get": {
      const property = given[0];
      if (!isGetProperty(property))
        throw new UsageError(
          `get needs one of ${GET_PROPERTIES.join(", ")}, then an element: get text e12`,
        );
      return { verb, property, target: target(true).target };
    }
    case "press":
      return { verb, key: need(1, "a key")[0] ?? "" };
    case "scroll": {
      // `scroll`, `scroll up`, `scroll down 300`, `scroll 300`. Anything
      // else (`scroll --to top`, `scroll -5000`, seen from an agent live)
      // is refused with the usage rather than read as "down 600".
      const direction =
        rest[0] === "up" || rest[0] === "down" ? rest[0] : "down";
      const extra = rest.slice(direction === rest[0] ? 1 : 0);
      const px = extra[0];
      if (extra.length > 1 || (px !== undefined && !/^\d+$/.test(px))) {
        throw new UsageError("scroll takes [up|down] [px]");
      }
      return { verb, direction, ...(px ? { pixels: Number(px) } : {}) };
    }
    case "back":
    case "reload":
    case "read":
    case "tabs":
    case "tab-close":
    case "stop":
      return { verb };
    case "screenshot": {
      const full = rest.includes("--full");
      const path = rest.find((a) => a !== "--full");
      return { verb, full, ...(path ? { path } : {}) };
    }
    case "tab":
      return { verb, id: need(1, "a tab id from tabs")[0] ?? "" };
    case "tab-new":
      return { verb, ...(rest[0] ? { url: rest[0] } : {}) };
    case "wait": {
      const flag = (name: string) => {
        const i = rest.indexOf(name);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      const ms = flag("--ms");
      const text = flag("--text");
      const gone = flag("--gone");
      const url = flag("--url");
      return {
        verb,
        ...(text !== undefined ? { text } : {}),
        ...(gone !== undefined ? { gone } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(ms !== undefined ? { ms: Number(ms) } : {}),
      };
    }
    case "eval":
      return {
        verb,
        js: need(1, "JavaScript")[0] !== undefined ? rest.join(" ") : "",
      };
    case "dialog": {
      const [answer, ...tail] = rest;
      if (answer === "accept")
        return {
          verb,
          answer,
          ...(tail.length > 0 ? { text: tail.join(" ") } : {}),
        };
      if (answer === "dismiss" && tail.length === 0) return { verb, answer };
      throw new UsageError("dialog takes accept [text] or dismiss");
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      throw new UsageError("");
    default:
      throw new UsageError(`unknown verb: ${verb}`);
  }
};

/** The reply as the agent reads it. */
export const formatReply = (reply: Reply): string => {
  if (!reply.ok) return `error: ${reply.error}`;
  const lines: string[] = [];
  if (reply.url) lines.push(`url: ${reply.url}`);
  if (reply.title) lines.push(`title: ${reply.title}`);
  if (reply.pending) {
    const { type, message, defaultValue } = reply.pending;
    const prefilled =
      type === "prompt" && defaultValue
        ? ` (prefilled: ${JSON.stringify(defaultValue)})`
        : "";
    lines.push(
      `dialog ${type}: ${message}${prefilled}`,
      `the page is stopped on it: answer with dialog accept${type === "prompt" ? " [text]" : ""} or dialog dismiss`,
    );
  }
  for (const modal of reply.modals ?? []) {
    const says = modal.text ? `: ${modal.text}` : "";
    const answers = modal.actions.map(describeAction).join(", ");
    lines.push(
      `modal "${modal.title}"${says}${answers ? ` [${answers}]` : ""}`,
    );
  }
  for (const alert of reply.alerts ?? []) lines.push(`alert: ${alert}`);
  if (reply.dialog) lines.push(`dialog (answered): ${reply.dialog}`);
  if (reply.challenge) {
    lines.push(
      "bot check: this site is verifying the browser and did not let it through on its own. Do not retry or wait on it; a person has to clear it (ask for a takeover where one is possible), then open the url again.",
    );
  }
  if (reply.tabs) {
    for (const t of reply.tabs)
      lines.push(
        `${t.active ? "*" : " "} ${t.id}  ${t.title || "(untitled)"}  ${t.url}`,
      );
  }
  if (reply.path) lines.push(`saved: ${reply.path}`);
  if (reply.text !== undefined) lines.push("", reply.text);
  if ("value" in reply) lines.push(JSON.stringify(reply.value, null, 2));
  if (reply.got !== undefined) lines.push(reply.got ?? "");
  if (reply.snapshot !== undefined)
    lines.push(
      "",
      reply.snapshot === "" ? "(no interactive elements)" : reply.snapshot,
    );
  return lines.length === 0 ? "ok" : lines.join("\n");
};

/** One request over the socket, one reply line back. */
const send = (socketPath: string, request: Request): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    };
    const timer = setTimeout(() => {
      finish(() => {
        socket.destroy();
        reject(new Error(`no reply in ${String(REPLY_TIMEOUT_MS / 1_000)} s`));
      });
    }, REPLY_TIMEOUT_MS);
    socket.once("error", (error) => finish(() => reject(error)));
    // The daemon dropped the connection without a reply: it was stopped
    // (or died) while this verb was running. The next call starts a fresh one.
    socket.once("close", () =>
      finish(() =>
        reject(
          new Error(
            "the browser driver stopped before answering; run the command again",
          ),
        ),
      ),
    );
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
      createInterface({ input: socket }).once("line", (line) => {
        finish(() => {
          socket.end();
          let parsedLine: unknown;
          try {
            parsedLine = JSON.parse(line);
          } catch {
            parsedLine = undefined;
          }
          if (isReply(parsedLine)) resolve(parsedLine);
          else
            reject(
              new Error("the driver sent a reply this command cannot read"),
            );
        });
      });
    });
  });

const isConnectRefused = (error: unknown): boolean =>
  error instanceof Error && /ECONNREFUSED|ENOENT/.test(error.message);

/** Start the daemon detached, so it outlives this command. */
const spawnDaemon = (daemonPath: string) => {
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
};

/** All of stdin, for `type <el> -`: a secret that must not sit on argv. */
const readStdin = async (): Promise<string> => {
  // A terminal on stdin means nothing was piped: refusing beats waiting
  // forever for input a non-interactive caller can never give.
  if (process.stdin.isTTY) {
    throw new UsageError(
      "type <el> - reads the text from stdin: pipe or redirect it",
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
};

export const run = async (argv: readonly string[]): Promise<number> => {
  // `launch` never goes through the daemon: it is what the desktop's dock
  // runs when a person opens Chrome, and a person must be able to while
  // they hold the screen (when the daemon refuses every verb). Loopback
  // off the proxy for its readiness probe, as the daemon does for itself.
  if (argv[0] === "launch") {
    Object.assign(process.env, withLoopbackUnproxied(process.env));
    await launchBrowser(environmentFromEnv(process.env));
    process.stdout.write("ok\n");
    return 0;
  }
  let request: Request;
  try {
    request = parseArgs(argv);
    if (request.verb === "type" && request.text === "-") {
      request = { ...request, text: await readStdin(), secret: true };
    }
  } catch (error) {
    if (error instanceof UsageError) {
      const out = error.message ? `${error.message}\n\n${USAGE}` : USAGE;
      process.stderr.write(`${out}\n`);
      return error.message ? 1 : 0;
    }
    throw error;
  }

  const socketPath = browserSocketPath(agentHomeDir(process.env));
  const daemonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "daemon.mjs",
  );

  let reply: Reply;
  try {
    reply = await send(socketPath, request);
  } catch (error) {
    if (!isConnectRefused(error)) throw error;
    if (request.verb === "stop") return 0; // nothing to stop
    spawnDaemon(daemonPath);
    const deadline = Date.now() + SPAWN_WAIT_MS;
    reply = { ok: false, error: "the browser driver did not start" };
    while (Date.now() < deadline) {
      await sleep(200);
      if (!existsSync(socketPath)) continue;
      try {
        reply = await send(socketPath, request);
        break;
      } catch (retryError) {
        if (!isConnectRefused(retryError)) throw retryError;
      }
    }
  }
  process.stdout.write(`${formatReply(reply)}\n`);
  return reply.ok ? 0 : 1;
};
