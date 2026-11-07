/**
 * The driver's one network peer is the DevTools port on loopback. The
 * sandbox environment carries the gateway proxy for everything else
 * (`HTTPS_PROXY`, honoured by Node through `NODE_USE_ENV_PROXY`), and a
 * loopback attach or probe would be sent there without this. Loopback is
 * never egress, so exempting it moves nothing off the fence.
 */
export const withLoopbackUnproxied = (
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const hosts = (env.NO_PROXY ?? env.no_proxy ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (const h of ["localhost", "127.0.0.1", "::1"]) {
    if (!hosts.includes(h)) hosts.push(h);
  }
  const value = hosts.join(",");
  return { ...env, NO_PROXY: value, no_proxy: value };
};
