import { describe, expect, it } from "vitest";
import {
  browserBinary,
  environmentFromEnv,
  launchArgs,
  launchLogPath,
  profileDir,
  type LaunchEnvironment,
} from "./launch";

const desktop: LaunchEnvironment = {
  display: ":1",
  proxy: "http://127.0.0.1:3128",
  homeDir: "/workspace",
  lang: "en_US.UTF-8",
};
const headless: LaunchEnvironment = {
  display: undefined,
  proxy: "http://127.0.0.1:3128",
  homeDir: "/workspace",
  lang: undefined,
};

describe("the launch environment", () => {
  it("reads each variable only in the shape the supervisor sets", () => {
    expect(
      environmentFromEnv({
        DISPLAY: ":1",
        OPEN_PROXY: "http://127.0.0.1:3128",
        AGENT_HOME_DIR: "/workspace",
        LANG: "pt_BR.UTF-8",
      }),
    ).toEqual({
      display: ":1",
      proxy: "http://127.0.0.1:3128",
      homeDir: "/workspace",
      lang: "pt_BR.UTF-8",
    });
  });

  it("ignores a planted display or proxy, and defaults the home", () => {
    // These reach the daemon through the agent's shell; a value an agent
    // edited must never point the browser at a foreign X server or proxy.
    const env = environmentFromEnv({
      DISPLAY: "evil.example:0",
      OPEN_PROXY: "http://10.0.0.1:3128",
      LANG: "C",
    });
    expect(env.display).toBeUndefined();
    expect(env.proxy).toBeUndefined();
    expect(env.lang).toBeUndefined();
    expect(env.homeDir).toBe("/workspace");
    expect(
      environmentFromEnv({ OPEN_PROXY: "http://127.0.0.1:3128/evil" }).proxy,
    ).toBeUndefined();
    expect(
      environmentFromEnv({ OPEN_PROXY: "http://127.0.0.1:3128@evil.example" })
        .proxy,
    ).toBeUndefined();
    expect(environmentFromEnv({ DISPLAY: ":1.0" }).display).toBe(":1.0");
  });
});

describe("the browser command line", () => {
  it("runs the desktop's Chrome visibly and the shared image's chromium headless", () => {
    expect(browserBinary(desktop)).toBe("google-chrome");
    expect(browserBinary(headless)).toBe("chromium");
    expect(launchArgs(desktop, { noSandbox: false })).toContain(
      "--start-maximized",
    );
    expect(launchArgs(desktop, { noSandbox: false })).not.toContain(
      "--headless=new",
    );
    expect(launchArgs(headless, { noSandbox: false })).toContain(
      "--headless=new",
    );
    expect(launchArgs(headless, { noSandbox: false })).not.toContain(
      "--start-maximized",
    );
  });

  it("carries none of the tells, and --no-sandbox only when the probe asks", () => {
    for (const env of [desktop, headless]) {
      const args = launchArgs(env, { noSandbox: false });
      for (const tell of [
        "--enable-automation",
        "--disable-gpu",
        "--test-type",
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
      ]) {
        expect(args).not.toContain(tell);
      }
      expect(launchArgs(env, { noSandbox: true })).toContain("--no-sandbox");
    }
  });

  it("puts the profile under the home, the DevTools port on loopback, and the proxy when set", () => {
    const args = launchArgs(desktop, { noSandbox: false });
    expect(args).toContain("--user-data-dir=/workspace/.chrome");
    expect(args).toContain("--remote-debugging-port=9222");
    expect(args).toContain("--proxy-server=http://127.0.0.1:3128");
    expect(
      launchArgs({ ...desktop, proxy: undefined }, { noSandbox: false }).join(
        " ",
      ),
    ).not.toContain("--proxy-server");
    expect(profileDir("/workspace")).toBe("/workspace/.chrome");
    expect(launchLogPath("/workspace")).toBe(
      "/workspace/.chrome/onecli-browser.log",
    );
  });

  it("turns LANG into the Accept-Language tag a person in that locale sends", () => {
    const tag = (lang: string | undefined) =>
      launchArgs({ ...desktop, lang }, { noSandbox: false }).find((a) =>
        a.startsWith("--lang="),
      );
    expect(tag("en_US.UTF-8")).toBe("--lang=en-US");
    expect(tag("pt_BR")).toBe("--lang=pt-BR");
    expect(tag("de")).toBe("--lang=de");
    expect(tag(undefined)).toBe("--lang=en-US");
  });
});
