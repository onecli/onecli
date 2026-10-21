import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { agentHomeDir } from "./paths";

/**
 * Starting the sandbox's browser, and finding it again. One browser per
 * sandbox, on one DevTools port on loopback, on a profile under the durable
 * home so cookies and logins survive a restart. The daemon attaches over
 * CDP; a person on the desktop and the agent share the same browser.
 *
 * Two shapes, decided by whether the sandbox has a desktop (`DISPLAY`):
 * - with one, the desktop's Chrome (the hosted platform's image ships it as
 *   `google-chrome`), visible and maximized, with the window manager and
 *   the managed policy the image gives a person's laptop;
 * - without one, the shared image's `chromium`, headless.
 *
 * Chromium's own sandbox needs user namespaces. Where the sandbox owns its
 * kernel (a VM) they are there; under a cap-dropped container (a self-hosted
 * Docker deployment) they are not, and the only fix is `--no-sandbox`. Which
 * one applies is probed, not configured: the first launch runs without the
 * flag, and only a browser that dies on the sandbox error is relaunched with
 * it. A VM never gets the flag (it is a headless tell sites look for).
 */

export const DEVTOOLS_PORT = 9222;
export const DEVTOOLS_ENDPOINT = `http://127.0.0.1:${String(DEVTOOLS_PORT)}`;

/** How long a launch may take before the browser is given up on. */
const LAUNCH_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

export interface LaunchEnvironment {
  /** The desktop's display, when the sandbox has one. */
  display: string | undefined;
  /** The open proxy's URL (`OPEN_PROXY`), the browser's only way out. */
  proxy: string | undefined;
  /** The durable home; the profile lives under it. */
  homeDir: string;
  /** `LANG`, for the Accept-Language a person in that locale sends. */
  lang: string | undefined;
}

/** The one shape a display takes (`:1`); anything else is treated as none. */
const DISPLAY_SHAPE = /^:\d+(\.\d+)?$/;
/** The open proxy is loopback by construction; a planted value is ignored. */
const OPEN_PROXY_SHAPE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
/** A locale tag worth passing on: `en_US`, `pt_BR.UTF-8`, `C` is dropped. */
const LANG_SHAPE = /^([a-z]{2,3})(?:_([A-Z]{2}))?(?:[.@].*)?$/;

const matching = (
  value: string | undefined,
  shape: RegExp,
): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return shape.test(trimmed) ? trimmed : undefined;
};

/**
 * The environment the launch reads. Each value is accepted only in the
 * exact shape the supervisor sets it in: these variables reach the daemon
 * through the agent's shell, and a value an agent (or a page it ran) edited
 * must not point the browser at a foreign display or proxy.
 */
export const environmentFromEnv = (
  env: NodeJS.ProcessEnv,
): LaunchEnvironment => ({
  display: matching(env.DISPLAY, DISPLAY_SHAPE),
  proxy: matching(env.OPEN_PROXY, OPEN_PROXY_SHAPE),
  homeDir: agentHomeDir(env),
  lang: matching(env.LANG, LANG_SHAPE),
});

export const profileDir = (homeDir: string): string => `${homeDir}/.chrome`;
/** The browser's own output, one launch per file: "see the log" after a failure. */
export const launchLogPath = (homeDir: string): string =>
  `${profileDir(homeDir)}/onecli-browser.log`;

/** The browser binary each shape runs; both are on PATH in their image. */
export const browserBinary = (environment: LaunchEnvironment): string =>
  environment.display ? "google-chrome" : "chromium";

/**
 * The command line. The flags a person's Chrome would NOT have are absent on
 * purpose (`--enable-automation`, `--disable-blink-features=…`,
 * `--disable-gpu`): each is a tell. `--no-sandbox` is added only by the
 * probe below.
 */
export const launchArgs = (
  environment: LaunchEnvironment,
  options: { noSandbox: boolean },
): string[] => {
  const locale = LANG_SHAPE.exec(environment.lang ?? "");
  const langTag = locale
    ? [locale[1], locale[2]].filter(Boolean).join("-")
    : "en-US";
  return [
    `--user-data-dir=${profileDir(environment.homeDir)}`,
    `--remote-debugging-port=${String(DEVTOOLS_PORT)}`,
    `--remote-allow-origins=http://127.0.0.1:${String(DEVTOOLS_PORT)},http://localhost:${String(DEVTOOLS_PORT)}`,
    ...(environment.proxy ? [`--proxy-server=${environment.proxy}`] : []),
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-features=TranslateUI",
    `--lang=${langTag}`,
    ...(environment.display
      ? ["--start-maximized", "--enable-unsafe-swiftshader"]
      : // A headless sandbox is a container with a 64 MB /dev/shm; without
        // this Chromium's renderer dies on a heavy page. Not a tell: it
        // changes where shared memory lives, nothing a page can see.
        [
          "--headless=new",
          "--window-size=1280,800",
          "--disable-dev-shm-usage",
        ]),
    ...(options.noSandbox ? ["--no-sandbox"] : []),
    "about:blank",
  ];
};

/**
 * Whether a browser already answers on the DevTools port. Plain `node:http`,
 * not `fetch`: the sandbox environment carries the gateway proxy, and a
 * client that honoured it would send this loopback probe to the gateway
 * (which refuses private addresses) and wait out its timeout on a browser
 * that was up in two seconds. `node:http` reads no proxy variables.
 */
export const browserListening = (): Promise<boolean> =>
  new Promise((resolve) => {
    const req = get(
      `${DEVTOOLS_ENDPOINT}/json/version`,
      { timeout: 1_500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });

const SANDBOX_ERROR = /No usable sandbox|Failed to move to new namespace/;

/**
 * Spawn the browser detached and unref'd (it outlives the daemon and the
 * shell that first asked for it). Resolves with its stderr when the process
 * exits; a browser that stays up never resolves, which is the point.
 */
const start = (
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logPath: string,
): Promise<string> =>
  new Promise((resolve) => {
    const child = spawn(binary, args, {
      env,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString();
    });
    const finish = (text: string) => {
      try {
        writeFileSync(logPath, text);
      } catch {
        // The log is a courtesy; the error itself is returned.
      }
      resolve(text);
    };
    child.once("exit", () => finish(stderr));
    child.once("error", (error) => finish(`${stderr}\n${error.message}`));
    child.unref();
  });

/**
 * Start the browser and wait until its DevTools port answers. Idempotent:
 * a browser already listening is left alone. Returns once attachable.
 */
export const launchBrowser = async (
  environment: LaunchEnvironment,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
  if (await browserListening()) return;
  const profile = profileDir(environment.homeDir);
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  // A stale lock from a previous life of this container would make the
  // browser refuse the profile: nothing else here opens it.
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(`${profile}/${f}`, { force: true });
  }
  const binary = browserBinary(environment);
  const childEnv = {
    ...env,
    ...(environment.display ? { DISPLAY: environment.display } : {}),
  };
  const logPath = launchLogPath(environment.homeDir);

  const attempt = async (
    noSandbox: boolean,
  ): Promise<"up" | "sandbox" | string> => {
    const exited = start(
      binary,
      launchArgs(environment, { noSandbox }),
      childEnv,
      logPath,
    );
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let done: string | null = null;
    void exited.then((err) => {
      done = err;
    });
    while (Date.now() < deadline) {
      if (await browserListening()) return "up";
      if (done !== null) return SANDBOX_ERROR.test(done) ? "sandbox" : done;
      await sleep(POLL_MS);
    }
    return `the browser did not come up in ${String(LAUNCH_TIMEOUT_MS)} ms`;
  };

  let outcome = await attempt(false);
  if (outcome === "sandbox") outcome = await attempt(true);
  if (outcome !== "up") {
    const tail = outcome.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`browser launch failed: ${tail} (log: ${logPath})`);
  }
};
