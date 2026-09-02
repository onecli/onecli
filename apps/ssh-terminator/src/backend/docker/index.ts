import type { TerminatorBackend } from "../types";
import { createDockerEngineApi } from "./engine-api";
import { createDockerExecBackend, type DockerExecTarget } from "./exec-backend";
import { createDockerResolver } from "./resolver";

export interface DockerBackendOptions {
  socketPath: string;
  /** Raw 32-byte CA public key — the resolver's own trust anchor. */
  caPublicKey: Buffer;
}

/** The docker substrate, fully assembled: the label-lookup resolver paired
 *  with the exec-hijack backend, one daemon client between them. */
export const createDockerBackend = (
  options: DockerBackendOptions,
): TerminatorBackend<DockerExecTarget> => {
  // The engine negotiates its API version lazily and retries on failure (see
  // engine-api.ts), so boot never hard-depends on the daemon being up before
  // the listener is — the first session resolves the version, and a daemon
  // blip at that moment self-heals on the next attempt.
  const engine = createDockerEngineApi(options.socketPath);
  return {
    resolver: createDockerResolver({
      engine,
      caPublicKey: options.caPublicKey,
    }),
    exec: createDockerExecBackend(engine),
  };
};
