// The Node half of the upgrade decisions. Both guards here were previously
// mutation-invisible: rewriting isPullableRef to `return true`, or deleting the
// whole ownership check, left the suite green because nothing imported them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentImageRef,
  composeProjectOwner,
  isPullableRef,
} from "./upgrade.mjs";

const envStub = (values) => ({ get: (k) => values[k] });

test("only references naming a registry host are pulled", () => {
  // Everything else is a Docker Hub shorthand: `onecli-agent:dev` becomes
  // docker.io/library/onecli-agent, so pulling it would fetch whatever a
  // squatter published there over a locally built image.
  for (const ref of [
    "ghcr.io/onecli/onecli-agent:2.1.0",
    "ghcr.io/o/a@sha256:abc",
    "localhost:5000/foo:1",
    "myreg:5000/team/img:1",
    "docker.io/library/onecli-agent:dev",
  ])
    assert.equal(isPullableRef(ref), true, ref);

  for (const ref of [
    "onecli-agent:dev",
    "onecli-agent",
    "onecli/onecli-agent:dev",
    "localhost/foo:1",
    "/foo:1",
    "",
  ])
    assert.equal(isPullableRef(ref), false, JSON.stringify(ref));
});

test("the agent image defaults to the compose default", () => {
  assert.equal(
    agentImageRef(envStub({}), {}),
    "ghcr.io/onecli/onecli-agent:latest",
  );
  assert.equal(
    agentImageRef(envStub({ ONECLI_VERSION: "2.1.0" }), {}),
    "ghcr.io/onecli/onecli-agent:2.1.0",
  );
  assert.equal(
    agentImageRef(envStub({ RUNNER_AGENT_IMAGE: "onecli-agent:dev" }), {}),
    "onecli-agent:dev",
  );
});

test("a shell value beats the env file, exactly as compose interpolates", () => {
  // The runner reads RUNNER_AGENT_IMAGE through compose, so resolving it by a
  // different precedence here would pull one image and start agents on
  // another. This is the mismatch the parity test now also checks live.
  assert.equal(
    agentImageRef(envStub({ RUNNER_AGENT_IMAGE: "ghcr.io/acme/file:1" }), {
      RUNNER_AGENT_IMAGE: "ghcr.io/acme/shell:2",
    }),
    "ghcr.io/acme/shell:2",
  );
  assert.equal(
    agentImageRef(envStub({ ONECLI_VERSION: "2.0.0" }), {
      ONECLI_VERSION: "2.1.0",
    }),
    "ghcr.io/onecli/onecli-agent:2.1.0",
  );
});

const withCheckout = (fn) => {
  const root = mkdtempSync(join(tmpdir(), "onecli-owner-"));
  const composeDir = join(root, "docker");
  mkdirSync(composeDir, { recursive: true });
  for (const f of [
    "docker-compose.yml",
    "docker-compose.dev.yml",
    "docker-compose.build.yml",
  ])
    writeFileSync(join(composeDir, f), "");
  const homeDir = join(root, "home");
  mkdirSync(join(homeDir, ".onecli"), { recursive: true });
  writeFileSync(join(homeDir, ".onecli", "docker-compose.yml"), "");
  try {
    return fn({ root, composeDir, homeDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("our own compose files are recognized as ours", () => {
  withCheckout(({ composeDir, homeDir }) => {
    for (const f of ["docker-compose.yml", "docker-compose.build.yml"])
      assert.deepEqual(
        composeProjectOwner([join(composeDir, f)], { composeDir, homeDir }),
        { ours: true },
        f,
      );
  });
});

test("the dev database counts as ours, not as a stranger", () => {
  // docker-compose.dev.yml deliberately sets `name: onecli` so `pnpm dev`
  // reuses the same postgres volume. Treating it as a foreign project would
  // refuse `pnpm run setup --upgrade` on every machine running the dev stack,
  // and tell the developer to run an installer that would mint a new
  // encryption key over their data.
  withCheckout(({ composeDir, homeDir }) => {
    assert.deepEqual(
      composeProjectOwner([join(composeDir, "docker-compose.dev.yml")], {
        composeDir,
        homeDir,
      }),
      { ours: true },
    );
  });
});

test("a checkout reached through a symlink still recognizes itself", () => {
  // Compose records the path as invoked; Node resolves symlinks. Without
  // realpath on both sides a symlinked checkout (or macOS /tmp) fails to
  // recognize its own project.
  withCheckout(({ root, composeDir, homeDir }) => {
    const link = join(root, "linked");
    symlinkSync(join(root, "docker"), link);
    assert.deepEqual(
      composeProjectOwner([join(link, "docker-compose.yml")], {
        composeDir,
        homeDir,
      }),
      { ours: true },
    );
  });
});

test("an install.sh-owned project is named as the installer's", () => {
  withCheckout(({ composeDir, homeDir }) => {
    const r = composeProjectOwner(
      [join(homeDir, ".onecli", "docker-compose.yml")],
      { composeDir, homeDir },
    );
    assert.equal(r.ours, false);
    // Only this kind may be told to re-run the installer. For any other
    // checkout that advice mints a fresh SECRET_ENCRYPTION_KEY over their data.
    assert.equal(r.kind, "installer");
  });
});

test("another checkout is NOT told to run the installer", () => {
  withCheckout(({ composeDir, homeDir }) => {
    const r = composeProjectOwner(
      ["/somewhere/else/docker/docker-compose.yml"],
      {
        composeDir,
        homeDir,
      },
    );
    assert.equal(r.ours, false);
    assert.equal(r.kind, "checkout");
    assert.equal(r.owner, "/somewhere/else/docker/docker-compose.yml");
  });
});

test("a failed probe is never read as permission", () => {
  // null (the probe could not run) must stay distinct from [] (it ran and
  // found nothing); collapsing them turns a docker hiccup into consent.
  withCheckout(({ composeDir, homeDir }) => {
    assert.deepEqual(composeProjectOwner(null, { composeDir, homeDir }), {
      ours: false,
      kind: "probe-failed",
    });
    assert.deepEqual(composeProjectOwner([], { composeDir, homeDir }), {
      ours: false,
      kind: "nothing-running",
    });
  });
});
