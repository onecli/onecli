# Nanoclaw Integration

Integrate OneCLI with [Nanoclaw](https://github.com/nanoclaw/nanoclaw) or any Docker-based agent orchestrator to route agent traffic through the OneCLI proxy.

## Prerequisites

- OneCLI instance running (self-hosted or cloud)
- User API key from the OneCLI dashboard (`oc_...`)

## Install

```bash
npm install @onecli-sdk/node
```

## Environment Variables

The orchestrator needs two env vars:

| Variable     | Required | Description                                              |
| ------------ | -------- | -------------------------------------------------------- |
| `ONECLI_KEY` | Yes      | User API key from OneCLI dashboard (`oc_...`)            |
| `ONECLI_URL` | No       | OneCLI instance URL. Defaults to `https://app.onecli.sh` |

For self-hosted: `ONECLI_URL=http://localhost:3000`

## Minimal Integration (standalone function)

Three lines of code:

```typescript
import { applyOneCLIConfig } from "@onecli-sdk/node";

// In your container startup logic:
const args = ["run", "-i", "--rm", "--name", "my-agent"];
await applyOneCLIConfig(args, process.env.ONECLI_KEY, process.env.ONECLI_URL);
// args is now mutated with -e HTTPS_PROXY=..., -v ca.pem:..., etc.
await exec("docker", [...args, "agent-image:latest"]);
```

`applyOneCLIConfig` returns `true` if the proxy was configured, `false` if OneCLI was unreachable. On failure the container runs without the proxy.

## Class-based Integration

For more control:

```typescript
import { OneCLI } from "@onecli-sdk/node";

const oc = new OneCLI({
  apiKey: process.env.ONECLI_KEY!,
  url: process.env.ONECLI_URL, // omit for cloud (app.onecli.sh)
});

const args = ["run", "-i", "--rm", "--name", "my-agent"];
const active = await oc.applyContainerConfig(args, {
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
const config = await oc.getContainerConfig();
// {
//   env: { HTTPS_PROXY: "...", HTTP_PROXY: "...", NODE_EXTRA_CA_CERTS: "...", NODE_USE_ENV_PROXY: "1" },
//   caCertificate: "-----BEGIN CERTIFICATE-----\n...",
//   caCertificateContainerPath: "/tmp/onecli-proxy-ca.pem"
// }
```

## Nanoclaw-specific Example

In Nanoclaw's `AgentRunner`, add OneCLI config before spawning the container:

```typescript
import { applyOneCLIConfig } from "@onecli-sdk/node";

class AgentRunner {
  async startAgent(image: string, name: string) {
    const args = ["run", "-i", "--rm", "--name", name];

    // Inject OneCLI proxy config (no-op if ONECLI_KEY is not set)
    await applyOneCLIConfig(
      args,
      process.env.ONECLI_KEY,
      process.env.ONECLI_URL,
    );

    args.push(image);
    return this.exec("docker", args);
  }
}
```

`applyOneCLIConfig` returns `false` when `apiKey` is falsy, so it's safe to always call — users without OneCLI just don't set `ONECLI_KEY`.
