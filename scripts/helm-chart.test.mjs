// The Helm chart (charts/onecli), pinned to the code it wires. Helm's own
// lint + a kubeconform pass run in CI (`helm-chart` job); this file holds the
// cross-repo invariants no YAML tool can see:
//
//   - the chart's route table carries exactly the dashboard's /auth pages
//     (apps/web/src/proxy.ts WEB_AUTH_PAGES)
//   - every RUNNER_KUBE_* env the chart sets is one the runner reads
//   - the Services the runner resolves into sandbox hostAliases exist under
//     the names the chart gives them, and the api's agent proxy address is
//     the gateway Service
//   - the sandbox egress policy selects the gateway/runner PODS by the same
//     selector labels their Deployments carry (an ipBlock on a ClusterIP
//     never matches; verified in the spike)
//   - every image the chart pulls is one publish.yml builds
//   - the chart ships no Docker socket, hostPath, or privileged anything
//   - every env compose hands a service the chart also runs is wired by the
//     chart or on a commented allowlist of intentional differences (the
//     drift that left Kubernetes without CHANNEL_ADAPTER_TOKEN and
//     RUNNER_SESSION_KEY)
//   - the adapter's env is env its config reads, and the api admits it with
//     the same Secret key
//   - every application-Secret key a template reads is one the generator
//     mints, in the same shape scripts/lib/secrets.mjs mints for compose
//
// Renders with the helm binary when one is on PATH (CI, most dev machines);
// the source-level pins run regardless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CHART = join(REPO, "charts/onecli");
const read = (rel) => readFileSync(join(REPO, rel), "utf8");

const templates = Object.fromEntries(
  readdirSync(join(CHART, "templates"))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".tpl"))
    .map((f) => [f, readFileSync(join(CHART, "templates", f), "utf8")]),
);
const allTemplates = Object.values(templates).join("\n");

// ── pins against the web proxy ────────────────────────────────────────────

test("the route table carries exactly the dashboard's /auth pages", () => {
  const proxy = read("apps/web/src/proxy.ts");
  const list = proxy.match(/export const WEB_AUTH_PAGES = \[([\s\S]*?)\];/);
  assert.ok(list, "WEB_AUTH_PAGES not found in proxy.ts");
  const pages = [...list[1].matchAll(/"(\/auth\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(pages.length >= 5);

  const routes = templates["_routes.tpl"];
  const block = routes.match(
    /define "onecli\.routes\.webAuthPages" -}}\n([\s\S]*?)\{\{- end -}}/,
  );
  assert.ok(block, "_routes.tpl lost onecli.routes.webAuthPages");
  const chartPages = [...block[1].matchAll(/^- (\/auth\/\S+)$/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    chartPages.sort(),
    pages.sort(),
    "charts/onecli/templates/_routes.tpl must list the same /auth pages as apps/web/src/proxy.ts WEB_AUTH_PAGES",
  );
});

test("the route table sends every api-server mount to the api", () => {
  // Same derivation as self-hosting-docs.test.mjs: apiApp's /v1 basePath,
  // every app.route() mount, and better-auth's /auth.
  const app = read("apps/api-server/src/app.ts");
  const mounts = new Set(["/v1"]);
  for (const m of app.matchAll(/app\.route\("(\/[^"]+)"/g)) mounts.add(m[1]);
  if (/BETTER_AUTH_BASE_PATH\}\/\*/.test(app)) mounts.add("/auth");
  mounts.delete("/"); // apiApp itself, mounted at the root with its own basePath
  const block = templates["_routes.tpl"].match(
    /define "onecli\.routes\.apiPrefixes" -}}\n([\s\S]*?)\{\{- end -}}/,
  );
  const chartPrefixes = [...block[1].matchAll(/^- (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(chartPrefixes.sort(), [...mounts].sort());
});

// ── pins against the runner ───────────────────────────────────────────────

test("every RUNNER_KUBE_* env the chart sets is read by the runner config", () => {
  const config = read("apps/runner/src/config.ts");
  const setByChart = new Set(
    [...templates["runner.yaml"].matchAll(/name: (RUNNER_[A-Z_]+)/g)].map(
      (m) => m[1],
    ),
  );
  assert.ok(setByChart.size >= 15, "the runner template lost its env block");
  for (const name of setByChart) {
    assert.ok(
      config.includes(`env.${name}`),
      `${name} is set by charts/onecli/templates/runner.yaml but apps/runner/src/config.ts never reads it`,
    );
  }
});

test("the runner's RUNNER_KUBE_NAMESPACE requirement is satisfied by the chart", () => {
  assert.match(
    templates["runner.yaml"],
    /name: RUNNER_KUBE_NAMESPACE\n\s+value:/,
  );
  assert.match(templates["runner.yaml"], /value: kubernetes\n/);
});

test("the Services the runner resolves exist under the chart's names, and agents are told to dial the gateway Service", () => {
  // The runner reads RUNNER_KUBE_{GATEWAY,RUNNER,API}_SERVICE and resolves
  // each to a ClusterIP in the control namespace: every one must be a
  // Service the chart creates, and its name must be built with the same
  // helper the Deployments use.
  const runner = templates["runner.yaml"];
  for (const component of ["gateway", "api"]) {
    assert.match(
      runner,
      new RegExp(
        `RUNNER_KUBE_${component.toUpperCase()}_SERVICE\\n\\s+value: \\{\\{ include "onecli\\.component" \\(dict "root" \\. "component" "${component}"\\) \\| quote \\}\\}`,
      ),
    );
    assert.match(
      templates[`${component}.yaml`],
      /kind: Service\nmetadata:\n  name: \{\{ \$name \}\}/,
    );
  }
  assert.match(
    runner,
    /RUNNER_KUBE_RUNNER_SERVICE\n\s+value: \{\{ \$name \| quote \}\}/,
  );
  // RUNNER_ADVERTISED_HOST is the hostname the sandbox dials for its control
  // channel: it must be the runner Service (the hostAlias the backend pins).
  assert.match(
    runner,
    /RUNNER_ADVERTISED_HOST\n\s+value: \{\{ \$name \| quote \}\}/,
  );
  // The api hands agents ONECLI_AGENT_PROXY_ADDRESS = the gateway Service.
  assert.match(
    templates["api.yaml"],
    /ONECLI_AGENT_PROXY_ADDRESS\n\s+value: \{\{ include "onecli\.agentProxyAddress" \. \| quote \}\}/,
  );
  assert.match(
    templates["_helpers.tpl"],
    /define "onecli\.agentProxyAddress" -}}\n\{\{ include "onecli\.component" \(dict "root" \. "component" "gateway"\) \}\}:10255/,
  );
});

test("the sandbox egress policy selects gateway and runner PODS by their Deployments' selector labels", () => {
  const policy = templates["sandboxes-networkpolicy.yaml"];
  // The gateway and runner rules must select pods: an ipBlock on a Service
  // ClusterIP never matches (the DNS rule may use one, for node-local
  // resolvers that have no pod to select).
  const spec = policy.slice(policy.indexOf("{{- if"));
  const dnsRuleAt = spec.indexOf("# DNS:");
  assert.ok(dnsRuleAt > 0);
  assert.doesNotMatch(
    spec.slice(0, dnsRuleAt),
    /ipBlock/,
    "an ipBlock on a Service ClusterIP never matches",
  );
  for (const component of ["gateway", "runner"]) {
    assert.match(
      policy,
      new RegExp(
        `podSelector:\\n\\s+matchLabels:\\n\\s+\\{\\{- include "onecli\\.selectorLabels" \\(dict "root" \\. "component" "${component}"\\)`,
      ),
      `the egress policy must select ${component} pods through onecli.selectorLabels`,
    );
    assert.match(
      templates[`${component}.yaml`],
      new RegExp(
        `selector:\\n\\s+matchLabels:\\n\\s+\\{\\{- include "onecli\\.selectorLabels" \\(dict "root" \\. "component" "${component}"\\)`,
      ),
    );
  }
  // The ports the fence opens are the ports the Services expose.
  assert.match(policy, /port: 10255/);
  assert.match(policy, /port: 8484/);
  assert.match(templates["gateway.yaml"], /containerPort: 10255/);
  assert.match(templates["runner.yaml"], /containerPort: 8484/);
  // The policy applies to the pods the backend labels.
  const backend = read(
    "apps/runner/src/backend/kubernetes/kubernetes-backend.ts",
  );
  assert.match(backend, /LABEL_ROLE = "onecli\.sh\/role"/);
  assert.match(backend, /ROLE_SANDBOX = "sandbox"/);
  assert.match(policy, /onecli\.sh\/role: sandbox/);
});

test("the runner's Role grants exactly what the backend uses, and never exec", () => {
  const rbac = templates["rbac.yaml"];
  const sandboxRole = rbac.slice(
    rbac.indexOf("kind: Role\n"),
    rbac.indexOf("kind: RoleBinding"),
  );
  const rules = [
    ...sandboxRole.matchAll(
      /resources: \["([a-z]+)"\]\n\s+verbs: \[([^\]]+)\]/g,
    ),
  ].map((m) => [m[1], m[2].replace(/["\s]/g, "").split(",").sort()]);
  assert.deepEqual(
    Object.fromEntries(rules),
    {
      jobs: ["create", "delete", "get", "list"],
      pods: ["get", "list"],
      persistentvolumeclaims: ["create", "delete", "get", "list"],
      secrets: ["create", "delete", "get", "list"],
    },
    "the sandbox-namespace Role drifted from what kubernetes-backend.ts calls",
  );
  const rbacSpec = rbac.slice(rbac.indexOf("{{- if"));
  assert.doesNotMatch(rbacSpec, /pods\/exec/);
  assert.doesNotMatch(rbacSpec, /networkpolicies/);
  assert.doesNotMatch(rbacSpec, /kind: ClusterRole/);
});

// ── images and hardening ──────────────────────────────────────────────────

test("every OneCLI image the chart pulls is one publish.yml builds", () => {
  const publish = read(".github/workflows/publish.yml");
  const built = publish
    .match(/service: \[([^\]]+)\]/)[1]
    .split(",")
    .map((s) => s.trim());
  const pulled = [
    ...allTemplates.matchAll(
      /"onecli\.image" \(dict "root" [.$] "service" "([a-z-]+)"\)/g,
    ),
  ].map((m) => m[1]);
  assert.ok(pulled.length >= 5);
  for (const service of new Set(pulled)) {
    assert.ok(
      built.includes(service),
      `the chart pulls onecli-${service} but publish.yml does not build it`,
    );
  }
});

test("no Docker socket, hostPath, privileged mode, or host namespaces anywhere in the chart", () => {
  for (const [file, body] of Object.entries(templates)) {
    for (const forbidden of [
      "docker.sock",
      "hostPath",
      "privileged: true",
      "hostNetwork",
      "hostPID",
      "hostIPC",
    ]) {
      assert.ok(!body.includes(forbidden), `${file} contains ${forbidden}`);
    }
  }
});

test("every pod drops all capabilities, runs non-root with the default seccomp profile, opts out of service links, and only the runner and generator Jobs mount a ServiceAccount token", () => {
  const podFiles = Object.entries(templates).filter(([, b]) =>
    /kind: (Deployment|StatefulSet|Job)\n/.test(b),
  );
  assert.ok(podFiles.length >= 8);
  for (const [file, body] of podFiles) {
    assert.match(
      body,
      /onecli\.podSecurityContext/,
      `${file}: pod securityContext`,
    );
    assert.match(
      body,
      /onecli\.containerSecurityContext/,
      `${file}: container securityContext`,
    );
    // Service links inject `<SERVICE>_PORT=tcp://...` for every Service in
    // the namespace; with the release named `onecli` that is
    // ONECLI_API_PORT / ONECLI_GATEWAY_PORT, names the public-origins
    // resolver reads. Nothing here relies on them.
    assert.match(
      body,
      /enableServiceLinks: false/,
      `${file}: enableServiceLinks: false`,
    );
    const mountsToken = /automountServiceAccountToken: true/.test(body);
    const allowed = [
      "runner.yaml",
      "job-secrets.yaml",
      "job-gateway-ca.yaml",
    ].includes(file);
    assert.equal(mountsToken, allowed, `${file}: ServiceAccount token mount`);
  }
  assert.match(templates["_helpers.tpl"], /runAsNonRoot: true/);
  assert.match(templates["_helpers.tpl"], /drop: \["ALL"\]/);
  assert.match(templates["_helpers.tpl"], /type: RuntimeDefault/);
});

test("the web pod receives API_INTERNAL_URL so its /auth page-path forward reaches the api in-cluster", () => {
  assert.match(
    templates["web.yaml"],
    /API_INTERNAL_URL\n\s+value: \{\{ include "onecli\.apiUrl" \. \| quote \}\}/,
  );
});

test("the values the templates read are the values values.yaml declares", () => {
  const values = read("charts/onecli/values.yaml");
  const reads = new Set(
    [...allTemplates.matchAll(/\.Values\.([a-zA-Z.]+)/g)].map((m) => m[1]),
  );
  for (const path of reads) {
    if (path === "nameOverride" || path === "fullnameOverride") continue; // scaffold convention, intentionally undocumented
    const [head, ...rest] = path.split(".");
    assert.match(
      values,
      new RegExp(`^${head}:`, "m"),
      `values.yaml lacks ${head} (read as .Values.${path})`,
    );
    // Deeper keys: check each segment appears indented somewhere after the head.
    for (const seg of rest) {
      assert.match(
        values,
        new RegExp(`^\\s+${seg}:`, "m"),
        `values.yaml lacks ${seg} (read as .Values.${path})`,
      );
    }
  }
});

// ── pins against compose, the adapter, and the secret generator ───────────

/** `environment:` keys per compose service (top-level services only). */
const composeEnv = () => {
  const compose = read("docker/docker-compose.yml");
  const services = {};
  let current = null;
  let inEnv = false;
  for (const line of compose.split("\n")) {
    const service = line.match(/^ {2}([a-z][a-z-]*):\s*$/);
    if (service) {
      current = service[1];
      services[current] = new Set();
      inEnv = false;
    } else if (/^\S/.test(line)) current = null;
    else if (!current) continue;
    else if (/^ {4}environment:/.test(line)) inEnv = true;
    else if (/^ {4}[a-z_]+:/.test(line)) inEnv = false;
    else if (inEnv) {
      const env = line.match(/^ {6}([A-Z][A-Z0-9_]*):/);
      if (env) services[current].add(env[1]);
    }
  }
  return services;
};

/** Env names a chart template sets, shared helpers resolved. */
const chartEnv = (file) => {
  const body = templates[file];
  const names = new Set(
    [...body.matchAll(/- name: ([A-Z][A-Z0-9_]*)\n/g)].map((m) => m[1]),
  );
  for (const m of body.matchAll(
    /"onecli\.optionalSecretEnv" \(dict "root" \. "name" "([A-Z_]+)"\)/g,
  ))
    names.add(m[1]);
  if (body.includes('"onecli.publicUrlEnv"')) {
    names.add("ONECLI_EXTERNAL_URL");
    names.add("ONECLI_TRUSTED_ORIGINS");
  }
  if (body.includes('"onecli.flagsEnv"')) names.add("ENTERPRISE_ENABLED");
  const shared = body.match(/range list ((?:"[A-Z_]+" ?)+)/);
  if (shared)
    for (const m of shared[1].matchAll(/"([A-Z_]+)"/g)) names.add(m[1]);
  return names;
};

// Compose env the chart deliberately does not set, each with its reason.
// Adding a line here is a review decision: the default is to wire it.
const SINGLE_ORIGIN =
  "the chart serves one origin (externalUrl); split-host overrides go through extraEnv";
const PORTS_MODE =
  "ports-mode publish facts; the chart is proxy mode (https externalUrl) only";
const LEGACY_SEED = "the deprecated ONECLI_BIND_HOST seed, compose-only";
const INTENTIONAL_GAPS = {
  api: {
    APP_URL: SINGLE_ORIGIN,
    API_URL: SINGLE_ORIGIN,
    GATEWAY_API_URL: SINGLE_ORIGIN,
    BETTER_AUTH_COOKIE_DOMAIN: SINGLE_ORIGIN,
    ONECLI_BIND_HOST: LEGACY_SEED,
    ONECLI_APP_PORT: PORTS_MODE,
    ONECLI_API_PORT: PORTS_MODE,
    ONECLI_GATEWAY_PORT: PORTS_MODE,
    SSH_PORT: "the SSH front door is not part of the chart yet",
  },
  web: {
    APP_URL: SINGLE_ORIGIN,
    API_URL: SINGLE_ORIGIN,
    GATEWAY_API_URL: SINGLE_ORIGIN,
    BETTER_AUTH_COOKIE_DOMAIN: SINGLE_ORIGIN,
    ONECLI_BIND_HOST: LEGACY_SEED,
    ONECLI_APP_PORT: PORTS_MODE,
    ONECLI_API_PORT: PORTS_MODE,
    ONECLI_GATEWAY_PORT: PORTS_MODE,
  },
  gateway: {
    APP_URL: SINGLE_ORIGIN,
    ONECLI_BIND_HOST: LEGACY_SEED,
    ONECLI_APP_PORT: PORTS_MODE,
  },
  runner: {
    RUNNER_SANDBOX_NETWORK:
      "a Docker network; the kubernetes backend fences by NetworkPolicy",
  },
  "channel-adapter": {
    APP_URL: SINGLE_ORIGIN,
    ONECLI_BIND_HOST: LEGACY_SEED,
    ONECLI_APP_PORT: PORTS_MODE,
  },
};
const CHART_FILE = {
  api: "api.yaml",
  web: "web.yaml",
  gateway: "gateway.yaml",
  runner: "runner.yaml",
  migrations: "job-migrations.yaml",
  "channel-adapter": "channel-adapter.yaml",
};

test("every env compose hands a service is wired by the chart or a documented intentional gap", () => {
  const compose = composeEnv();
  for (const [service, file] of Object.entries(CHART_FILE)) {
    assert.ok(compose[service]?.size, `compose lost the ${service} service`);
    const wired = chartEnv(file);
    const gaps = INTENTIONAL_GAPS[service] ?? {};
    for (const name of compose[service]) {
      assert.ok(
        wired.has(name) || name in gaps,
        `compose gives ${service} ${name} but charts/onecli/templates/${file} never sets it. ` +
          "Wire it (the Kubernetes self-host runs the same env contract), or add it to INTENTIONAL_GAPS with the reason.",
      );
    }
    // A stale allowlist entry hides the next real gap: every entry must
    // still be compose env the chart leaves unset.
    for (const name of Object.keys(gaps)) {
      assert.ok(
        compose[service].has(name) && !wired.has(name),
        `INTENTIONAL_GAPS.${service}.${name} is stale: drop it`,
      );
    }
  }
});

test("the adapter's env is env its config reads, and the api admits it with the same Secret key", () => {
  const config = read("apps/channel-adapter/src/config.ts");
  const set = chartEnv("channel-adapter.yaml");
  assert.ok(set.has("CHANNEL_ADAPTER_TOKEN") && set.has("CONTROL_PLANE_URL"));
  for (const name of set) {
    assert.ok(
      config.includes(`env.${name}`),
      `${name} is set by charts/onecli/templates/channel-adapter.yaml but apps/channel-adapter/src/config.ts never reads it`,
    );
  }
  // A stable name keeps the adapter's row (and presence leases) across a
  // restart; the hostname fallback would orphan them on every rollout.
  assert.match(
    templates["channel-adapter.yaml"],
    /CHANNEL_ADAPTER_NAME\n\s+value: \{\{ \$name \| quote \}\}/,
  );
  assert.match(
    templates["channel-adapter.yaml"],
    /CONTROL_PLANE_URL\n\s+value: \{\{ include "onecli\.apiUrl" \. \| quote \}\}/,
  );
  // Both sides read CHANNEL_ADAPTER_TOKEN from the application Secret: the
  // api through the shared helper (which names onecli.secretsName), the
  // adapter directly.
  assert.match(
    templates["channel-adapter.yaml"],
    /name: \{\{ include "onecli\.secretsName" \. \}\}\n\s+key: CHANNEL_ADAPTER_TOKEN/,
  );
  assert.match(
    templates["api.yaml"],
    /"onecli\.optionalSecretEnv" \(dict "root" \. "name" "CHANNEL_ADAPTER_TOKEN"\)/,
  );
  assert.match(
    templates["_helpers.tpl"],
    /define "onecli\.optionalSecretEnv"[\s\S]*?name: \{\{ include "onecli\.secretsName" \.root \}\}/,
  );
});

test("every application-Secret key a template reads is minted by the generator, in compose's shape", () => {
  const tool = templates["configmap-secret-tool.yaml"];
  const specs = tool.match(/const APP_SECRET_SPECS = \{([\s\S]*?)\n\s*\};/);
  assert.ok(specs, "configmap-secret-tool.yaml lost APP_SECRET_SPECS");
  const minted = Object.fromEntries(
    [...specs[1].matchAll(/^\s*([A-Z_]+): (.+?),?$/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );

  // Keys read from the application Secret, directly or through the helper.
  const consumed = new Set();
  for (const body of Object.values(templates)) {
    for (const m of body.matchAll(
      /name: \{\{ include "onecli\.secretsName" \. \}\}\n\s+key: ([A-Z_]+)/g,
    ))
      consumed.add(m[1]);
    for (const m of body.matchAll(
      /"onecli\.optionalSecretEnv" \(dict "root" \. "name" "([A-Z_]+)"\)/g,
    ))
      consumed.add(m[1]);
  }
  assert.ok(
    consumed.size >= 6,
    `expected the application keys, got ${[...consumed]}`,
  );
  for (const key of consumed) {
    assert.ok(
      key in minted,
      `templates read ${key} but the generator never mints it`,
    );
  }

  // Same prefixes the setup wizard / install.sh mint for compose, so a
  // value moved between the two stacks is accepted by both.
  const specsMjs = read("scripts/lib/secrets.mjs");
  for (const [key, prefix] of [
    ["RUNNER_TOKEN", "rnr_"],
    ["RUNNER_SESSION_KEY", "k1."],
    ["CHANNEL_ADAPTER_TOKEN", "cha_"],
  ]) {
    assert.ok(
      minted[key].includes(`\`${prefix}`),
      `${key} is minted without ${prefix}`,
    );
    const spec = specsMjs.slice(specsMjs.indexOf(`key: "${key}"`));
    const generate = spec.match(/generate: \(\) => `([^$`]*)\$/);
    assert.equal(
      generate?.[1],
      prefix,
      `scripts/lib/secrets.mjs mints ${key} with a different prefix`,
    );
  }
});

// ── rendered output, when helm is available ───────────────────────────────

const helm = (() => {
  for (const candidate of ["helm", process.env.HELM]) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["version", "--short"], { stdio: "pipe" });
      return candidate;
    } catch {}
  }
  return null;
})();

const render = (args) =>
  execFileSync(
    helm,
    [
      "template",
      "onecli",
      CHART,
      "--set",
      "externalUrl=https://onecli.example.test",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

test(
  "rendered: every container sets readOnlyRootFilesystem (api and web get an emptyDir /tmp)",
  { skip: !helm && "helm not on PATH" },
  () => {
    const out = render(["--set", "secrets.generate.enabled=true"]);
    const rw = out.match(/readOnlyRootFilesystem: false/g) ?? [];
    // The bundled postgres is the one container that must write its root.
    assert.ok(rw.length <= 1, `${rw.length} containers have a writable root`);
    assert.match(out, /mountPath: \/tmp/);
  },
);

test(
  "rendered: the ingress and the HTTPRoute agree on the split",
  { skip: !helm && "helm not on PATH" },
  () => {
    const out = render([
      "--set",
      "secrets.existingSecret=s",
      "--set",
      "ingress.enabled=true",
      "--set",
      "httpRoute.enabled=true",
      "--set",
      "httpRoute.parentRefs[0].name=eg",
    ]);
    for (const page of [
      "/auth/login",
      "/auth/signup",
      "/auth/cli",
      "/auth/forgot-password",
      "/auth/reset-password",
    ]) {
      assert.match(
        out,
        new RegExp(`path: ${page}\\n\\s+pathType: Exact`),
        `ingress exact ${page}`,
      );
      assert.match(
        out,
        new RegExp(`type: Exact, value: "${page}"`),
        `httproute exact ${page}`,
      );
    }
    assert.match(out, /replacePrefixMatch: \//);
    assert.match(out, /hostnames:\n\s+- "onecli\.example\.test"/);
    assert.match(out, /host: "onecli\.example\.test"/);
  },
);

test(
  "rendered: refuses the configurations that cannot work",
  { skip: !helm && "helm not on PATH" },
  () => {
    const refuses = (args, message) => {
      assert.throws(
        () => render(args),
        (error) => String(error.stderr).includes(message),
        `expected the render to refuse with "${message}"`,
      );
    };
    refuses([], "secrets.existingSecret");
    refuses(
      ["--set", "secrets.existingSecret=s", "--set", "api.replicas=2"],
      "/api/replicas",
    );
    refuses(
      ["--set", "secrets.existingSecret=s", "--set", "database.enabled=false"],
      "database.external.existingSecret",
    );
    refuses(
      [
        "--set",
        "secrets.existingSecret=s",
        "--set",
        "database.external.url=postgresql://x",
      ],
      "pick one",
    );
    refuses(
      ["--set", "secrets.existingSecret=s", "--set", "gateway.replicas=2"],
      "gateway.replicas > 1 needs shared state",
    );
    // Licensed multi-instance: the shared stores make a second replica safe.
    render([
      "--set",
      "secrets.existingSecret=s",
      "--set",
      "gateway.replicas=2",
      "--set",
      "enterpriseEnabled=true",
      "--set",
      "gateway.extraEnv[0].name=REDIS_HOST",
      "--set",
      "gateway.extraEnv[0].value=redis.internal",
    ]);
  },
);

/** One rendered document by kind and name. */
const doc = (out, kind, name) =>
  out
    .split(/^---$/m)
    .find(
      (d) => d.includes(`kind: ${kind}\n`) && d.includes(`name: ${name}\n`),
    );

test(
  "rendered: the channel adapter is off by default, and the api then admits no adapter",
  { skip: !helm && "helm not on PATH" },
  () => {
    const out = render(["--set", "secrets.existingSecret=s"]);
    assert.equal(doc(out, "Deployment", "onecli-channel-adapter"), undefined);
    assert.doesNotMatch(
      doc(out, "Deployment", "onecli-api"),
      /CHANNEL_ADAPTER_TOKEN/,
    );
  },
);

test(
  "rendered: channelAdapter.enabled wires the adapter and the api to one Secret key",
  { skip: !helm && "helm not on PATH" },
  () => {
    const out = render([
      "--set",
      "secrets.existingSecret=s",
      "--set",
      "channelAdapter.enabled=true",
    ]);
    const adapter = doc(out, "Deployment", "onecli-channel-adapter");
    assert.ok(adapter, "no channel-adapter Deployment");
    assert.match(adapter, /replicas: 1\n\s+strategy:\n\s+type: Recreate/);
    assert.match(adapter, /name: s\n\s+key: CHANNEL_ADAPTER_TOKEN\n/);
    assert.match(adapter, /value: "http:\/\/onecli-api:10256"/);
    assert.match(adapter, /value: "http:\/\/onecli-gateway:10255"/);
    assert.match(adapter, /value: "onecli-channel-adapter"/);
    assert.match(adapter, /readOnlyRootFilesystem: true/);
    assert.match(adapter, /automountServiceAccountToken: false/);
    assert.equal(doc(out, "Service", "onecli-channel-adapter"), undefined);
    // BYO Secret: the api's ref is optional, so a Secret missing the key
    // can never keep the api from starting.
    assert.match(
      doc(out, "Deployment", "onecli-api"),
      /name: s\n\s+key: CHANNEL_ADAPTER_TOKEN\n\s+optional: true/,
    );
  },
);

test(
  "rendered: refs to newer keys are optional with your own Secret, required with the generated one",
  { skip: !helm && "helm not on PATH" },
  () => {
    const byo = render([
      "--set",
      "secrets.existingSecret=s",
      "--set",
      "channelAdapter.enabled=true",
    ]);
    assert.match(
      doc(byo, "Deployment", "onecli-runner"),
      /key: RUNNER_SESSION_KEY\n\s+optional: true/,
    );
    const generated = render([
      "--set",
      "secrets.generate.enabled=true",
      "--set",
      "channelAdapter.enabled=true",
    ]);
    for (const [deploy, key] of [
      ["onecli-runner", "RUNNER_SESSION_KEY"],
      ["onecli-api", "CHANNEL_ADAPTER_TOKEN"],
    ]) {
      const body = doc(generated, "Deployment", deploy);
      assert.match(
        body,
        new RegExp(`name: onecli-secrets\\n\\s+key: ${key}\\n`),
      );
      assert.doesNotMatch(body, new RegExp(`key: ${key}\\n\\s+optional`));
    }
  },
);

test(
  "rendered: the shared Slack app reads its own Secret, every key optional",
  { skip: !helm && "helm not on PATH" },
  () => {
    const api = doc(
      render([
        "--set",
        "secrets.existingSecret=s",
        "--set",
        "slackSharedApp.existingSecret=slack",
        "--set",
        "slackSharedApp.appManagerApproved=true",
      ]),
      "Deployment",
      "onecli-api",
    );
    for (const key of [
      "SLACK_SHARED_CLIENT_ID",
      "SLACK_SHARED_CLIENT_SECRET",
      "SLACK_SHARED_SIGNING_SECRET",
      "SLACK_SHARED_APP_ID",
    ]) {
      assert.match(
        api,
        new RegExp(`name: slack\\n\\s+key: ${key}\\n\\s+optional: true`),
      );
    }
    assert.match(api, /SLACK_SHARED_APP_MANAGER_APPROVED\n\s+value: "true"/);
  },
);

test(
  "rendered: values carried over from an older release (--reuse-values) render with Slack off, and say how to fix Slack on",
  { skip: !helm && "helm not on PATH" },
  () => {
    // `--set key=null` deletes the key: exactly the values an older
    // release hands `--reuse-values`, which never had these blocks.
    const stale = [
      "--set",
      "secrets.existingSecret=s",
      "--set",
      "channelAdapter=null",
      "--set",
      "slackSharedApp=null",
    ];
    assert.doesNotMatch(render(stale), /channel-adapter/);
    assert.throws(
      () =>
        execFileSync(
          helm,
          [
            "template",
            "onecli",
            CHART,
            "--set",
            "externalUrl=https://onecli.example.test",
            "--set",
            "secrets.existingSecret=s",
            "-f",
            "-",
          ],
          {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            input: "channelAdapter: { enabled: true, resources: null }\n",
          },
        ),
      (error) => String(error.stderr).includes("--reset-then-reuse-values"),
    );
  },
);

test(
  "rendered: the generator may patch only its own Secret",
  { skip: !helm && "helm not on PATH" },
  () => {
    // Render-level, so it also proves `$name` binds to `onecli-secrets`.
    // The newer keys being minted is implied by "every application-Secret
    // key a template reads is minted by the generator".
    const out = render(["--set", "secrets.generate.enabled=true"]);
    const role = doc(out, "Role", "onecli-secrets-generate");
    assert.match(
      role,
      /resources: \["secrets"\]\n\s+verbs: \["create"\]/,
      "create cannot be name-scoped (the name is in the body)",
    );
    assert.match(
      role,
      /resourceNames: \["onecli-secrets"\]\n\s+verbs: \["get", "patch"\]/,
    );
    assert.doesNotMatch(role, /"(update|delete|list|watch)"/);
  },
);
