/**
 * Where the driver's pieces meet, under the agent's durable home: the
 * socket the command talks to, and the marker the supervisor sets while a
 * person holds the screen. One definition, read by the command, the
 * daemon, and the supervisor's takeover arm.
 *
 * Under the home and not /tmp: the home is the agent's own (0700), so the
 * socket is reachable by the agent's processes and nobody else, which is
 * the whole access control. /tmp is shared with the SSH door.
 */

const STATE_DIR = ".onecli";

export const browserStateDir = (homeDir: string): string =>
  `${homeDir}/${STATE_DIR}`;

/** The daemon's unix socket. */
export const browserSocketPath = (homeDir: string): string =>
  `${browserStateDir(homeDir)}/browser.sock`;

/**
 * Present while a person holds the screen (the hosted platform's takeover):
 * the daemon refuses every verb but `stop` while it exists. Written and
 * removed by the supervisor; never by the daemon or the command.
 *
 * What it is and is not: a courtesy to the person, the same one the steer
 * message asks of the model, made to hold at the one place every browser
 * verb passes through. It is NOT a security boundary. The agent runs as
 * the same uid as the supervisor, so a process of its own could remove the
 * file or speak CDP to the browser directly; what it cannot do is keep
 * `onecli-browser` working by accident while a person types. The security
 * boundary for a takeover stays where it was: the screen servers and the
 * gateway.
 */
export const browserHoldPath = (homeDir: string): string =>
  `${browserStateDir(homeDir)}/browser.hold`;

/** Where screenshots land when the verb names no path. */
export const browserOutputDir = (homeDir: string): string =>
  `${browserStateDir(homeDir)}/screenshots`;

/** The home the sandbox's pieces agree on (`AGENT_HOME_DIR`, `/workspace` by default). */
export const agentHomeDir = (env: NodeJS.ProcessEnv): string =>
  env.AGENT_HOME_DIR?.trim() || "/workspace";
