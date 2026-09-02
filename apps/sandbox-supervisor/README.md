# @onecli/sandbox-supervisor

The program that runs **inside** a hosted agent's sandbox: it renders the home
instruction files, drives the harness behind the vendor-neutral
`@onecli/agent-protocol` interface, and speaks the supervisor transport — work
items in, canonical events out.

## Shape

- **Harness adapters** (`src/harness/`): `jcode.ts` (the real one — every
  vendor-specific switch lives there and nowhere else) and `fake.ts` (in-process,
  no Docker, no key). Both pass `src/harness/conformance.ts` — the suite that
  makes the interface real.
- **Home renderer** (`src/home/renderer.ts`): brief → preamble
  (boundary map) → capability fragments; rebuilt read-only at every boot.
- **Transport** (`src/transport/`): the stdio driver (JSONL on stdin/stdout;
  stdout is protocol-only, logs go to stderr) and the WebSocket driver that
  dials the runner, behind the same seam.

## Tests

```bash
pnpm --filter @onecli/sandbox-supervisor test      # unit + fake conformance (CI)
JCODE_LIVE_TEST=1 pnpm --filter @onecli/sandbox-supervisor exec \
  vitest run src/harness/jcode.live.conformance.test.ts   # live, env-gated
```

The live suite needs the bundled jcode runtime plus a credential path —
either a real key in the environment, or placeholder envs with a dev gateway
injecting at the wire.

## The live loop

`dev/run-local.sh` is the whole thesis in one command: container-config in,
placeholders-only container up, one turn piped, the model's real answer
streaming back through the gateway. See the header for prereqs. The automated
form of this proof is the `apps/hosted-e2e` black-box suite.
