// Port probes shared by `pnpm dev` and `pnpm run setup`.

import { execFileSync } from "node:child_process";
import { connect } from "node:net";

/** Is something listening there? */
export const portBusy = (port, host = "127.0.0.1") =>
  new Promise((res) => {
    const sock = connect({ host, port });
    const done = (busy) => {
      sock.destroy();
      res(busy);
    };
    sock.setTimeout(400);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });

/**
 * Who holds a port — `"node (pid 41234)"` — so a conflict message can name
 * the culprit instead of shrugging. Returns null when lsof is unavailable or
 * says nothing (fine: the caller degrades to the bare port number).
 */
export const portOwner = (port) => {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const row = out.trim().split("\n")[1];
    if (!row) return null;
    const [command, pid] = row.split(/\s+/);
    return { command, pid, isDocker: /^(com\.docke|docker)/i.test(command) };
  } catch {
    return null;
  }
};
