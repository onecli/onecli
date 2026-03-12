# Nanoclaw Integration

Integrate OneCLI with [Nanoclaw](https://github.com/nanoclaw/nanoclaw) or any Docker-based agent orchestrator to route agent traffic through the OneCLI proxy.

## Prerequisites

- OneCLI instance running (self-hosted or cloud)
- User API key from the OneCLI dashboard (`oc_...`)

## Install

```bash
npm install @onecli-sh/sdk
```

## Environment Variables

The orchestrator needs two env vars:

| Variable         | Required | Description                                              |
| ---------------- | -------- | -------------------------------------------------------- |
| `ONECLI_API_KEY` | Yes      | User API key from OneCLI dashboard (`oc_...`)            |
| `ONECLI_URL`     | No       | OneCLI instance URL. Defaults to `https://app.onecli.sh` |

For self-hosted: `ONECLI_URL=http://localhost:10254`

## Quick Start

```typescript
import { OneCLI } from "@onecli-sh/sdk";

// Reads ONECLI_API_KEY and ONECLI_URL from environment
const onecli = new OneCLI();

const args = ["run", "-i", "--rm", "--name", "my-agent"];
await onecli.applyContainerConfig(args);
// args is now mutated with -e HTTPS_PROXY=..., -v ca.pem:..., etc.
await exec("docker", [...args, "agent-image:latest"]);
```

## Usage

```typescript
import { OneCLI } from "@onecli-sh/sdk";

const onecli = new OneCLI({
  apiKey: process.env.ONECLI_API_KEY, // or omit to read from env
  url: process.env.ONECLI_URL, // omit for cloud (app.onecli.sh)
});

const args = ["run", "-i", "--rm", "--name", "my-agent"];
const active = await onecli.applyContainerConfig(args, {
  combineCaBundle: true, // merge system + OneCLI CAs (default: true)
  addHostMapping: true, // --add-host on Linux (default: true)
});

if (active) {
  console.log("Proxy configured — credentials will be injected");
} else {
  console.log("OneCLI not reachable — running without proxy");
}

await exec("docker", [...args, "agent-image:latest"]);
```

## What the SDK Does

When `applyContainerConfig` succeeds, it mutates the Docker args array with:

1. **Proxy env vars** — `-e HTTPS_PROXY=...`, `-e HTTP_PROXY=...`, `-e NODE_USE_ENV_PROXY=1`
2. **Node.js CA trust** — `-e NODE_EXTRA_CA_CERTS=/tmp/onecli-proxy-ca.pem` + volume mount
3. **System-wide CA trust** — `-e SSL_CERT_FILE=/tmp/onecli-combined-ca.pem` + volume mount (covers curl, Python, Go, git)
4. **Linux host mapping** — `--add-host host.docker.internal:host-gateway` (macOS Docker Desktop provides this automatically)

Traffic from the container goes through the proxy, which injects credentials on matching requests.

## Advanced: Raw Config

If you need the raw config (e.g. for a non-Docker runtime):

```typescript
const config = await onecli.getContainerConfig();
// {
//   env: { HTTPS_PROXY: "...", HTTP_PROXY: "...", NODE_EXTRA_CA_CERTS: "...", NODE_USE_ENV_PROXY: "1" },
//   caCertificate: "-----BEGIN CERTIFICATE-----\n...",
//   caCertificateContainerPath: "/tmp/onecli-proxy-ca.pem"
// }
```

## Nanoclaw-specific Example

In Nanoclaw's container runner, add OneCLI config before spawning the container:

```typescript
import { OneCLI } from "@onecli-sh/sdk";

// Inject OneCLI proxy config (skipped if ONECLI_API_KEY is not set)
const onecliApiKey = process.env.ONECLI_API_KEY;
if (onecliApiKey) {
  const onecli = new OneCLI({
    apiKey: onecliApiKey,
    url: process.env.ONECLI_URL,
  });
  const active = await onecli.applyContainerConfig(args);
  if (active) {
    console.log("OneCLI proxy config applied");
  }
}
```

Users without OneCLI simply don't set `ONECLI_API_KEY` — no code changes needed.
