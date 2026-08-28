import type { TerminatorBackend } from "../types";
import { createKubeExecBackend, type KubeExecTarget } from "./exec-backend";
import { createKubeResolver, type KubeResolverOptions } from "./resolver";

/** The kube substrate, fully assembled: the manager-broker resolver paired
 *  with the pods/exec backend, speaking one target vocabulary. */
export const createKubeBackend = (
  options: KubeResolverOptions,
): TerminatorBackend<KubeExecTarget> => ({
  resolver: createKubeResolver(options),
  exec: createKubeExecBackend(),
});
