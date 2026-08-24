import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pins the deploy-workflow contract three ways. (1) All four deploy
// workflows share one deploy-<env> concurrency group — the sandbox platform
// reads live core state at deploy time and relies on that mutual exclusion.
// (2) Every image-tag context the sandbox cluster stack reads is passed by
// deploy-sandbox-platform.yml — a new image added to the stack without
// workflow plumbing would silently deploy the mutable <env>-latest fallback.
// (3) deploy.yml's subset-run gateway pin and the gateway stack's
// gatewayAppVersion override exist together — either half alone reverts to
// rolling the gateway (the sandbox egress data plane) on api-server/app-only
// deploys.

const path = (rel) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel) => readFileSync(path(rel), "utf8");

// `scripts/` syncs to OSS, where the deploy workflows and packages/infra are
// absent by design — there this file must be a silent no-op (the
// scripts/cloud-boundary.test.mjs precedent, incl. keying repo identity on
// the root package name, which the sync rewrites field-level). Reads stay
// inside the tests so the OSS repo never even opens the missing files.
const inCloudRepo = JSON.parse(read("package.json")).name === "onecli-cloud";

test(
  "all four deploy workflows share the deploy-<env> group, no cancel-in-progress",
  { skip: !inCloudRepo },
  () => {
    for (const name of [
      "deploy.yml",
      "deploy-sandbox-platform.yml",
      "deploy-infra.yml",
      "deploy-analytics.yml",
    ]) {
      assert.match(
        read(`.github/workflows/${name}`),
        /^concurrency:\n  group: deploy-\$\{\{ inputs\.environment \}\}\n  cancel-in-progress: false$/m,
        `${name} left the shared deploy-<env> concurrency group`,
      );
    }
  },
);

test(
  "every image-tag context the cluster stack reads is passed by the sandbox workflow",
  { skip: !inCloudRepo },
  () => {
    // The stack reads tags only through imageUri(logicalId, repo, contextKey)
    // call sites with literal "<x>ImageTag" keys; the workflow passes them as
    // --context <x>ImageTag=... lines.
    const stackKeys = new Set(
      [
        ...read(
          "packages/infra/lib/sandbox-platform/sandbox-cluster-stack.ts",
        ).matchAll(/"(\w+ImageTag)"/g),
      ].map((m) => m[1]),
    );
    const workflowKeys = new Set(
      [
        ...read(".github/workflows/deploy-sandbox-platform.yml").matchAll(
          /--context (\w+ImageTag)=/g,
        ),
      ].map((m) => m[1]),
    );
    assert.ok(stackKeys.size >= 6, "cluster stack image contexts went missing");
    assert.deepEqual(workflowKeys, stackKeys);
  },
);

test(
  "unchecked sandbox components resolve live tags instead of <env>-latest",
  { skip: !inCloudRepo },
  () => {
    // The resolver and its first-deploy fail-fast: get-template against the
    // live cluster stack, exactly-one-live-tag enforcement, and the refusal
    // message. Without these, an unchecked box would re-pin to the mutable
    // fallback and roll the component anyway.
    const sandboxYml = read(".github/workflows/deploy-sandbox-platform.yml");
    assert.match(
      sandboxYml,
      /aws cloudformation get-template --stack-name "onecli-\$\{ENV\}-sandbox-cluster"/,
    );
    assert.match(sandboxYml, /a first deploy must check every component box/);
    assert.match(sandboxYml, /run a full deploy \(all boxes\) first/);
  },
);

test(
  "deploy.yml pins BOTH gateway synth inputs on subset runs, and the stack reads the override",
  { skip: !inCloudRepo },
  () => {
    // The elif branch: api-server/app pull the gateway stack into the CDK
    // closure, so runs without the gateway box must pin the live tag AND the
    // live APP_VERSION (appVersion alone carries this run's sha and would
    // roll the service).
    const deployYml = read(".github/workflows/deploy.yml");
    assert.match(
      deployYml,
      /--context gatewayImageTag=\$\{LIVE_TAG\} --context gatewayAppVersion=\$\{LIVE_APP_VERSION\}/,
    );
    assert.match(deployYml, /a first deploy must include the gateway box/);
    assert.match(
      read("packages/infra/lib/gateway-stack.ts"),
      /tryGetContext\("gatewayAppVersion"\)/,
      "gateway-stack.ts lost the gatewayAppVersion override the workflow pin depends on",
    );
  },
);
