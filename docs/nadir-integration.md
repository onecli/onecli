# Nadir Integration

Right-size the model on every LLM call that passes through the gateway. Agents keep asking for their most capable model; the gateway rewrites `model` to the cheapest tier that can actually do the task, using [Nadir](https://getnadir.com)'s complexity classifier.

Nadir also appears in **Connections > Apps** as a normal API-key app, so the gateway can inject your Nadir key into calls your agents make to `api.getnadir.com` directly. That part works on its own and needs none of the routing setup below.

## How It Works

1. An agent sends a completion request through the gateway, pinning whatever model it always pins
2. The gateway recognises the LLM endpoint and buffers the request body
3. The prompt is sent to Nadir, which classifies it as `simple`, `medium`, or `complex`
4. The gateway rewrites `model` to the tier you mapped that bucket to, then forwards the request

The agent's code, SDK, and credentials are untouched. It asked for one model and got an answer; only the gateway knows a cheaper one served it.

## What Gets Sent to Nadir

**When routing is enabled, the prompt text of every routed request is sent to `api.getnadir.com` for classification.** That is the trade: classification needs the text. This is why the feature ships off and stays off until you set `NADIR_MODEL_ROUTING=1`.

Only requests to completion endpoints on known LLM hosts are affected. Nothing else your agents do is sent anywhere.

## Setup

Routing is off unless configured. Set these on the gateway:

```bash
NADIR_MODEL_ROUTING=1
NADIR_API_KEY=sk-...   # optional
```

The key is optional: routing works against Nadir's free anonymous tier. Supplying one raises the rate limit and records per-request savings in your Nadir dashboard.

Restart the gateway. Requests to `POST /v1/messages` and `POST /v1/chat/completions` on known LLM hosts are now routed.

## The Tier Ladder

The gateway only rewrites a model you have placed on a ladder. This is deliberate: an unranked model is one the gateway cannot prove a swap makes cheaper, so it is forwarded untouched.

Anthropic ships defaults:

| Bucket    | Default model       | Override                  |
| --------- | ------------------- | ------------------------- |
| `simple`  | `claude-haiku-4-5`  | `NADIR_ANTHROPIC_SIMPLE`  |
| `medium`  | `claude-sonnet-4-6` | `NADIR_ANTHROPIC_MEDIUM`  |
| `complex` | `claude-opus-4-6`   | `NADIR_ANTHROPIC_COMPLEX` |

OpenAI has no defaults, because its model names move fast enough that a hardcoded ladder would eventually route to a model you never chose. Set them to turn OpenAI routing on:

```bash
NADIR_OPENAI_SIMPLE=gpt-5-mini
NADIR_OPENAI_MEDIUM=gpt-5
NADIR_OPENAI_COMPLEX=gpt-5-pro
```

A request whose model is not on the matching ladder is forwarded unchanged, and never reaches the classifier.

## Environment Variables

| Variable                  | Default             | Description                                                           |
| ------------------------- | ------------------- | --------------------------------------------------------------------- |
| `NADIR_MODEL_ROUTING`     | off                 | `1` enables routing. Nothing happens without it                       |
| `NADIR_API_KEY`           | —                   | Optional. Higher rate limit and savings analytics                     |
| `NADIR_ALLOW_UPGRADE`     | off                 | `1` permits routing _up_ the ladder. Off so cost cannot silently rise |
| `NADIR_TIMEOUT_MS`        | `1500`              | Ceiling on the classifier round-trip                                  |
| `NADIR_ANTHROPIC_SIMPLE`  | `claude-haiku-4-5`  | Anthropic ladder, cheapest tier                                       |
| `NADIR_ANTHROPIC_MEDIUM`  | `claude-sonnet-4-6` | Anthropic ladder, middle tier                                         |
| `NADIR_ANTHROPIC_COMPLEX` | `claude-opus-4-6`   | Anthropic ladder, top tier                                            |
| `NADIR_OPENAI_SIMPLE`     | —                   | OpenAI ladder, cheapest tier. Unset means OpenAI is not routed        |
| `NADIR_OPENAI_MEDIUM`     | —                   | OpenAI ladder, middle tier                                            |
| `NADIR_OPENAI_COMPLEX`    | —                   | OpenAI ladder, top tier                                               |

## Failure Behaviour

Routing never blocks a request. If Nadir is slow, down, returns an error, or returns a bucket with no model mapped, the original request is forwarded byte for byte with its original model. A classifier outage costs you the savings, not the call.

`max_tokens` is clamped down if the routed-to model has a lower output ceiling than the caller asked for, which would otherwise be a provider 400. It is only ever lowered.

## Scope and Limits

- Only `POST /v1/messages` and `POST /v1/chat/completions` are routed. Other endpoints (embeddings, batches, files) pass through
- Requests above 256 KB skip classification: nothing that large classifies as simple, and the round-trip would cost more than it saves
- Configuration is per-gateway, not per-project. A per-project toggle in the dashboard is the natural follow-up
- Streaming is unaffected. Only the request body is buffered; responses stream as normal
