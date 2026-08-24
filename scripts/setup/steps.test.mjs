// provisionEnv's networking half: the external-URL persist/freeze/hint logic
// and the bind/URL cross-check. Each case runs against a temp EnvFile
// pre-seeded with valid secrets, DOCKER_GID and COMPOSE_PROFILES so the
// docker-dependent branches (gid detection, legacy-volume probe) never run.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { EnvFile } from "../lib/env-file.mjs";
import {
  externalUrlProblem,
  provisionEnv,
  resolveDisplayUrls,
} from "./steps.mjs";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");
const SEED = [
  `SECRET_ENCRYPTION_KEY=${VALID_KEY}`,
  "BETTER_AUTH_SECRET=seeded-better-auth-secret",
  "GATEWAY_INTERNAL_SECRET=seeded-gateway-secret",
  `RUNNER_TOKEN=rnr_${"a".repeat(64)}`,
  `CHANNEL_ADAPTER_TOKEN=cha_${"a".repeat(64)}`,
  "DOCKER_GID=0",
  "COMPOSE_PROFILES=runner",
].join("\n");

const makeEnv = (extraLines = []) => {
  const dir = mkdtempSync(join(tmpdir(), "onecli-steps-test-"));
  const path = join(dir, ".env");
  writeFileSync(path, [SEED, ...extraLines].join("\n") + "\n");
  const env = new EnvFile(path, { label: "steps.test" });
  return { dir, env };
};

test("persists an explicit --external-url, slashes stripped", async () => {
  const { dir, env } = makeEnv();
  await provisionEnv(env, {
    bind: "127.0.0.1",
    externalUrl: "http://192.168.1.20:10254/",
  });
  assert.equal(env.get("ONECLI_EXTERNAL_URL"), "http://192.168.1.20:10254");
  rmSync(dir, { recursive: true, force: true });
});

test("refuses an invalid --external-url with a SetupError", async () => {
  const { dir, env } = makeEnv();
  await assert.rejects(
    () => provisionEnv(env, { bind: "127.0.0.1", externalUrl: "no-scheme" }),
    /http:\/\/ or https:\/\//,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("freezes the URL from a non-loopback bind", async () => {
  const { dir, env } = makeEnv();
  await provisionEnv(env, { bind: "172.17.0.1" });
  assert.equal(env.get("ONECLI_EXTERNAL_URL"), "http://172.17.0.1:10254");
  rmSync(dir, { recursive: true, force: true });
});

test("a loopback bind gets the hint stub, which a later run self-upgrades", async () => {
  const { dir, env } = makeEnv();
  await provisionEnv(env, { bind: "127.0.0.1" });
  assert.equal(env.get("ONECLI_EXTERNAL_URL"), undefined);
  env.save();

  // The stub self-documents; a later upsert un-comments it in place.
  const reread = new EnvFile(env.path, { label: "steps.test" });
  reread.upsert("ONECLI_EXTERNAL_URL", "http://192.168.1.20:10254");
  assert.equal(reread.get("ONECLI_EXTERNAL_URL"), "http://192.168.1.20:10254");
  rmSync(dir, { recursive: true, force: true });
});

test("keep-existing: a configured URL survives a re-run with a different flag", async () => {
  const { dir, env } = makeEnv(["ONECLI_EXTERNAL_URL=http://kept.example:10254"]);
  await provisionEnv(env, {
    bind: "127.0.0.1",
    externalUrl: "http://other.example:10254",
  });
  assert.equal(env.get("ONECLI_EXTERNAL_URL"), "http://kept.example:10254");
  rmSync(dir, { recursive: true, force: true });
});

test("an existing APP_URL alias suppresses freeze and hint", async () => {
  const { dir, env } = makeEnv(["APP_URL=https://kept.example"]);
  await provisionEnv(env, { bind: "172.17.0.1" });
  assert.equal(env.get("ONECLI_EXTERNAL_URL"), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("externalUrlProblem accepts plain origins and rejects the traps", () => {
  assert.equal(externalUrlProblem("http://192.168.1.20:10254"), undefined);
  assert.equal(externalUrlProblem("https://onecli.example.com/"), undefined);
  assert.match(externalUrlProblem("onecli.example.com"), /http:\/\//);
  assert.match(externalUrlProblem("http://0.0.0.0:10254"), /bind address/);
  assert.match(externalUrlProblem("https://x.example/sub"), /subpath/);
});

test("resolveDisplayUrls derives ports mode from the canonical URL", async () => {
  const { dir, env } = makeEnv([
    "ONECLI_EXTERNAL_URL=http://192.0.2.10:24812",
    "ONECLI_API_PORT=24813",
    "ONECLI_GATEWAY_PORT=24814",
  ]);
  assert.deepEqual(resolveDisplayUrls(env), {
    external: "http://192.0.2.10:24812",
    api: "http://192.0.2.10:24813",
    gateway: "http://192.0.2.10:24814",
  });
  rmSync(dir, { recursive: true, force: true });
});

test("resolveDisplayUrls: https means proxy mode; a bare alias never derives", async () => {
  const { dir, env } = makeEnv(["ONECLI_EXTERNAL_URL=https://onecli.example.com"]);
  assert.deepEqual(resolveDisplayUrls(env), {
    external: "https://onecli.example.com",
    api: "https://onecli.example.com",
    gateway: "https://onecli.example.com/gw",
  });
  rmSync(dir, { recursive: true, force: true });

  const alias = makeEnv(["APP_URL=https://dashboard.example.com"]);
  assert.deepEqual(resolveDisplayUrls(alias.env), {
    external: "https://dashboard.example.com",
    api: "http://localhost:10256",
    gateway: "http://localhost:10255",
  });
  rmSync(alias.dir, { recursive: true, force: true });
});
