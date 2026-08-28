import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Thin docker CLI helpers. The suite's own hygiene tooling — the runner
 * under test speaks the Engine API through its backend; these exist for what
 * a TEST must do around it (exec into a sandbox, kill one mid-turn, plant an
 * orphan, sweep stale runs).
 */

export const dockerExec = async (
  container: string,
  cmd: string[],
): Promise<{ stdout: string; stderr: string }> =>
  exec("docker", ["exec", container, ...cmd]);

export const dockerKill = async (container: string): Promise<void> => {
  await exec("docker", ["kill", container]).catch(() => {});
};

export const dockerRm = async (container: string): Promise<void> => {
  await exec("docker", ["rm", "-f", container]).catch(() => {});
};

export const dockerNetworkRm = async (network: string): Promise<void> => {
  await exec("docker", ["network", "rm", network]).catch(() => {});
};

export const containerNameFor = (sandboxId: string): string =>
  `onecli-sandbox-${sandboxId}`;

export const volumeNameFor = (sandboxId: string): string =>
  `onecli-home-${sandboxId}`;

const lines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * Sweep leftovers from KILLED prior runs, by the `he2e-` name prefix the ids
 * module pins — real deployments' sandbox ids are cuids, so this can never
 * touch a developer's live stack. Belt-and-braces: names, then per-test
 * networks by their own prefix.
 */
export const sweepStaleRuns = async (): Promise<void> => {
  const containers = await exec("docker", [
    "ps",
    "-aq",
    "--filter",
    "name=onecli-sandbox-he2e-",
  ]).catch(() => ({ stdout: "" }));
  for (const id of lines(containers.stdout)) {
    await exec("docker", ["rm", "-f", id]).catch(() => {});
  }

  const volumes = await exec("docker", [
    "volume",
    "ls",
    "-q",
    "--filter",
    "name=onecli-home-he2e-",
  ]).catch(() => ({ stdout: "" }));
  for (const name of lines(volumes.stdout)) {
    await exec("docker", ["volume", "rm", "-f", name]).catch(() => {});
  }

  const networks = await exec("docker", [
    "network",
    "ls",
    "--format",
    "{{.Name}}",
    "--filter",
    "name=oce2e-",
  ]).catch(() => ({ stdout: "" }));
  for (const name of lines(networks.stdout)) {
    await exec("docker", ["network", "rm", name]).catch(() => {});
  }
};

/** Loud assertion that the daemon and the agent image are usable. */
export const assertDockerReady = async (agentImage: string): Promise<void> => {
  await exec("docker", ["version", "--format", "{{.Server.Version}}"]).catch(
    (error: unknown) => {
      throw new Error(
        `docker daemon unreachable — the hosted E2E suite needs one: ${String(error)}`,
      );
    },
  );
  await exec("docker", ["image", "inspect", agentImage]).catch(() => {
    throw new Error(
      `agent image "${agentImage}" not found. Build it first:\n  pnpm agent:build`,
    );
  });
};
