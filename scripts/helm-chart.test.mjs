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

test("every pod drops all capabilities, runs non-root with the default seccomp profile, and only the runner and generator Jobs mount a ServiceAccount token", () => {
  const podFiles = Object.entries(templates).filter(([, b]) =>
    /kind: (Deployment|StatefulSet|Job)\n/.test(b),
  );
  assert.ok(podFiles.length >= 7);
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
  },
);
