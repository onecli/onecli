import { getApp } from "../apps/registry";
import {
  allGroupTools,
  getAppPermissionDefinitions,
  hostPatternsOf,
} from "../apps/app-permissions";
import { PREVIEW_DOMAIN } from "../lib/env";
import { HOST_BOUND_PROVIDERS } from "../lib/connection-display";
import { LLM_HOST_FRAGMENTS } from "../lib/llm-hosts";
import { resolveOriginsFromEnv } from "../lib/public-origins";
import { logger } from "../lib/logger";
import {
  registrableDomainOf,
  type CustomConnectionProposal,
} from "../validations/custom-connection";

const log = logger.child({ service: "custom-connection-policy" });

/**
 * The host POLICY half of a custom-connection proposal: the checks the pure
 * schema can't make because they need the catalog and this deployment's own
 * origins. Run at propose time (the agent hears the refusal) and AGAIN at
 * approve time from the frozen payload (a catalog app or an origin added in
 * between still wins).
 *
 * Both compare by REGISTRABLE DOMAIN, the unit of ownership: a key for
 * `*.github.com` is a GitHub key whether or not the catalog lists that exact
 * host.
 */

export type ProposalRefusal =
  | { kind: "onecli_host" }
  | { kind: "reflector_host"; domain: string }
  | { kind: "llm_host" }
  | { kind: "catalog_app"; appId: string; appName: string };

/**
 * Registrable domains of public request bins, echo services and tunnels.
 * Each one hands whatever it receives (headers included) back to whoever
 * holds the URL, so a key injected there is a key disclosed. A tricked
 * agent proposing one of these is refused outright, whatever the card says.
 */
const REFLECTOR_DOMAINS: ReadonlySet<string> = new Set([
  "httpbin.org",
  "postman-echo.com",
  "webhook.site",
  "requestbin.com",
  "requestbin.net",
  "requestcatcher.com",
  "pipedream.net",
  "beeceptor.com",
  "mockbin.org",
  "mockbin.io",
  "hookbin.com",
  "putsreq.com",
  "requestinspector.com",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "ngrok.dev",
  "ngrok-free.dev",
  "trycloudflare.com",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "localhost.run",
  "lhr.life",
  "burpcollaborator.net",
  "oastify.com",
  "interact.sh",
  "oast.fun",
  "oast.me",
  "oast.pro",
  "oast.live",
  "oast.site",
  "oast.online",
  "canarytokens.com",
]);

/**
 * The reflector domain a host sits under, matched on whole-label suffixes of
 * the host itself (several tunnel domains are public suffixes, so each
 * tunnel would otherwise count as its own registrable domain).
 */
const reflectorDomainOf = (hostPattern: string): string | null => {
  const labels = hostPattern
    .toLowerCase()
    .split(".")
    .filter((label) => label !== "*");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    if (REFLECTOR_DOMAINS.has(suffix)) return suffix;
  }
  return null;
};

const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin.includes("://") ? origin : `http://${origin}`)
      .hostname;
  } catch {
    return null;
  }
};

/**
 * Registrable domains (or bare hosts, when there is none) OneCLI answers on:
 * its dashboard, api, gateway and agent proxy, and the sandbox preview zone,
 * whose hosts run agent-written code.
 */
const onecliDomains = (): Set<string> => {
  const out = new Set<string>();
  const add = (host: string) =>
    out.add(registrableDomainOf(host) ?? host.toLowerCase());
  try {
    const origins = resolveOriginsFromEnv();
    for (const raw of [
      origins.app,
      origins.api,
      origins.gateway,
      origins.agentProxyAddress,
    ]) {
      const host = hostOf(raw);
      if (host) add(host);
    }
  } catch (err) {
    // A misconfigured origin must not open the door: the schema already
    // refuses non-public hosts, and a refusal here would only be stricter.
    log.warn({ err: String(err) }, "could not resolve public origins");
  }
  if (PREVIEW_DOMAIN) add(PREVIEW_DOMAIN);
  return out;
};

/** registrable domain -> the catalog app that owns it. Built once. */
let catalogDomains: Map<string, { appId: string; appName: string }> | null =
  null;

const catalogDomainIndex = (): Map<
  string,
  { appId: string; appName: string }
> => {
  if (catalogDomains) return catalogDomains;
  const index = new Map<string, { appId: string; appName: string }>();
  const add = (pattern: string, appId: string) => {
    const domain = registrableDomainOf(pattern);
    if (domain && !index.has(domain)) {
      index.set(domain, { appId, appName: getApp(appId)?.name ?? appId });
    }
  };
  for (const def of getAppPermissionDefinitions()) {
    for (const group of def.groups) {
      for (const tool of allGroupTools(group)) {
        for (const pattern of hostPatternsOf(tool)) add(pattern, def.provider);
      }
    }
  }
  // Host-bound apps' per-tenant zones (`*.jfrog.io`): an app with no tool
  // catalog (JFrog) is only known here.
  for (const [appId, { zone }] of Object.entries(HOST_BOUND_PROVIDERS)) {
    add(`*${zone}`, appId);
  }
  catalogDomains = index;
  return index;
};

export const checkProposalHost = (
  proposal: Pick<CustomConnectionProposal, "hostPattern">,
): ProposalRefusal | null => {
  const domain = registrableDomainOf(proposal.hostPattern);
  // The schema guarantees a domain; a null here is refused outright.
  if (!domain) return { kind: "onecli_host" };
  if (onecliDomains().has(domain)) return { kind: "onecli_host" };
  const reflector = reflectorDomainOf(proposal.hostPattern);
  if (reflector) return { kind: "reflector_host", domain: reflector };
  // A model provider's key is an LLM key (the agent's Models page), never a
  // custom one: a custom secret there would ride the agent's own model
  // traffic beside its LLM key, and the platform trial credit reads any
  // credential on an LLM host as the user's own key. The same fragment list
  // the gateway's `is_llm_host` and the credit check use.
  if (
    LLM_HOST_FRAGMENTS.some((fragment) =>
      proposal.hostPattern.includes(fragment),
    )
  ) {
    return { kind: "llm_host" };
  }
  const app = catalogDomainIndex().get(domain);
  if (app) return { kind: "catalog_app", ...app };
  return null;
};

/** The model-facing words for a refusal. */
export const proposalRefusalMessage = (refusal: ProposalRefusal): string => {
  switch (refusal.kind) {
    case "onecli_host":
      return "That host belongs to OneCLI itself; a custom connection can't target it.";
    case "reflector_host":
      return `${refusal.domain} is a request-inspection, echo or tunnel service: anything sent there, the key included, is visible to others. A custom connection can't target it. Use the service's own official API host from its documentation.`;
    case "llm_host":
      return "That host is an AI model provider. Its key is a model key, not a custom connection: ask the user to add it on your Models page in the OneCLI dashboard.";
    case "catalog_app":
      return `${refusal.appName} is a built-in OneCLI app. Don't create a custom connection for it: ask the user to connect ${refusal.appName} in the OneCLI dashboard (Connections), then call list_apps.`;
  }
};
