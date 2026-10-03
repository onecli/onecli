import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pins the deploy-workflow contract five ways. (1) All four deploy
// workflows share one deploy-<env> concurrency group — the sandbox platform
// reads live core state at deploy time and relies on that mutual exclusion.
// (2) Every image-tag context the sandbox cluster stack reads is passed by
// deploy-sandbox-platform.yml — a new image added to the stack without
// workflow plumbing would silently deploy the mutable <env>-latest fallback.
// (3) deploy.yml's subset-run gateway pin and the gateway stack's
// gatewayAppVersion override exist together — either half alone reverts to
// rolling the gateway (the sandbox egress data plane) on api-server/app-only
// deploys. (4) Every `cdk deploy` is `--exclusively`: a service deploy
// touches only the stacks it names, never its dependency closure (which
// holds every foundation stack, re-synthesized from the deploying branch).
// (5) The account-level stacks (no env in their id) are deployed by
// deploy-infra.yml's account job alone, under its own global queue — the
// per-env queue cannot serialize two envs on a stack that belongs to
// neither (plans/deploy-ownership.md; the 2026-09-17 registry prune).

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
    assert.ok(stackKeys.size >= 8, "cluster stack image contexts went missing");
    assert.deepEqual(workflowKeys, stackKeys);
  },
);

test(
  "every sandbox component box gates its builds, the nothing-selected guard, and the live-tag fetch",
  { skip: !inCloudRepo },
  () => {
    // A new box wired into its build job but forgotten in either guard
    // would (a) let an all-unchecked run through as a silent no-op, or (b)
    // skip the live-template fetch, so resolve() runs against an empty
    // template and refuses a deploy that should have pinned the live tag.
    const yml = read(".github/workflows/deploy-sandbox-platform.yml");
    const inputsBlock = yml.slice(
      yml.indexOf("    inputs:"),
      yml.indexOf("\npermissions:"),
    );
    const boxes = [...inputsBlock.matchAll(/^ {6}(\w+):\n {8}description:/gm)]
      .map((m) => m[1])
      .filter((name) => name !== "environment");
    assert.ok(boxes.includes("logShipper"), "logShipper box went missing");
    assert.ok(boxes.length >= 5, `expected >=5 component boxes, got ${boxes}`);
    for (const box of boxes) {
      assert.match(
        yml,
        new RegExp(`if: inputs\\.${box}\\n`),
        `${box}: no build job gated on the box`,
      );
      const guards = yml.match(
        new RegExp(`\\[ "\\$\\{\\{ inputs\\.${box} \\}\\}" != "true" \\]`, "g"),
      );
      assert.equal(
        guards?.length,
        2,
        `${box}: must appear in BOTH the nothing-selected guard and the live-template fetch`,
      );
    }
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

const DEPLOY_WORKFLOWS = [
  "deploy.yml",
  "deploy-sandbox-platform.yml",
  "deploy-infra.yml",
  "deploy-analytics.yml",
];

/** Every `cdk deploy` invocation line in a workflow (continuation lines of a
 * backslash-wrapped command are joined first). */
const cdkDeployLines = (yml) =>
  yml
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => /pnpm exec cdk deploy\b/.test(line));

test(
  "every cdk deploy in every deploy workflow is --exclusively (no closure deploys)",
  { skip: !inCloudRepo },
  () => {
    for (const name of DEPLOY_WORKFLOWS) {
      const lines = cdkDeployLines(read(`.github/workflows/${name}`));
      assert.ok(lines.length > 0, `${name}: no cdk deploy line found`);
      for (const line of lines) {
        // The flag may sit on the line itself or inside a CDK_ARGS variable
        // the line expands; either way it must be literally present in the
        // same run block, which the workflow-wide check below enforces.
        assert.ok(
          /--exclusively/.test(line) || /\$\{?CDK_ARGS\}?/.test(line),
          `${name}: cdk deploy without --exclusively: ${line.trim()}`,
        );
      }
    }
    // Where the flag rides in CDK_ARGS, every CDK_ARGS *definition* carries it
    // (appends via CDK_ARGS="${CDK_ARGS} ..." inherit it).
    for (const name of DEPLOY_WORKFLOWS) {
      const yml = read(`.github/workflows/${name}`);
      for (const m of yml.matchAll(/CDK_ARGS="(?!\$\{CDK_ARGS\})([^"]*)"/g)) {
        assert.match(
          m[1],
          /--exclusively/,
          `${name}: CDK_ARGS defined without --exclusively: ${m[0]}`,
        );
      }
    }
  },
);

test(
  "account-level stacks are deployed only by deploy-infra's account job, under its own global queue",
  { skip: !inCloudRepo },
  () => {
    // Every stack bin/onecli.ts constructs with a literal (env-less) id.
    const accountStacks = [
      ...read("packages/infra/bin/onecli.ts").matchAll(
        /new \w+Stack\(app, "(onecli-[a-z-]+)"/g,
      ),
    ].map((m) => m[1]);
    assert.ok(accountStacks.length >= 4, "expected the four account stacks");

    const infra = read(".github/workflows/deploy-infra.yml");
    // The account job: its own global group, and every account stack in its
    // STACKS line (audit joins conditionally, so it appears as an append).
    assert.match(
      infra,
      /^  deploy-account:\n(?:.*\n)*?    concurrency:\n      group: deploy-account\n      cancel-in-progress: false$/m,
      "deploy-infra.yml lost the deploy-account job or its global concurrency group",
    );
    const accountJob = infra.slice(
      infra.indexOf("  deploy-account:"),
      infra.indexOf("  deploy-infra:"),
    );
    for (const stack of accountStacks) {
      assert.ok(
        accountJob.includes(stack),
        `${stack} is not deployed by the account job`,
      );
    }
    // The env job needs the account job (the env stacks import its exports).
    assert.match(
      infra,
      /^  deploy-infra:\n(?:.*\n)*?    needs: deploy-account$/m,
    );

    // No other deploy line anywhere names an account stack.
    for (const name of DEPLOY_WORKFLOWS) {
      const yml = read(`.github/workflows/${name}`);
      const body =
        name === "deploy-infra.yml" ? yml.replace(accountJob, "") : yml;
      for (const line of body.split("\n")) {
        if (!/STACKS=|cdk deploy/.test(line) || /^\s*#/.test(line)) continue;
        for (const stack of accountStacks) {
          assert.ok(
            !line.includes(stack),
            `${name}: ${stack} deployed outside the account job: ${line.trim()}`,
          );
        }
      }
    }
  },
);
