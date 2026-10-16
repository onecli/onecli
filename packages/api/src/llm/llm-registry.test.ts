import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropic } from "./anthropic";
import { openai } from "./openai";
import { local } from "./local";
import { LLM_PROVIDERS, isLlmProviderId } from "./registry";
import { getModelCatalog, resetModelCatalogCache } from "./catalog-cache";
import { resolveAgentModel } from "./resolve";

describe("the provider definitions", () => {
  it("never offers an empty fallback — an empty picker is not a legal state", () => {
    for (const provider of Object.values(LLM_PROVIDERS))
      expect(provider.fallback.length).toBeGreaterThan(0);
  });

  it("can resolve its own default with no network", () => {
    for (const provider of Object.values(LLM_PROVIDERS)) {
      expect(provider.defaultModel).not.toBe("");
      expect(provider.isSelectable(provider.defaultModel)).toBe(true);
    }
  });

  it("keys every provider by the secret type that names it", () => {
    for (const [key, provider] of Object.entries(LLM_PROVIDERS))
      expect(provider.id).toBe(key);
    expect(isLlmProviderId("anthropic")).toBe(true);
    expect(isLlmProviderId("generic")).toBe(false);
  });

  it("hardcodes each hosted catalog URL — never derived from a stored host", () => {
    for (const provider of Object.values(LLM_PROVIDERS)) {
      // `local` is the ONE deliberate exception (the SSRF note in types.ts):
      // its catalog URL comes from the user's own base URL, not a constant.
      if (provider.catalogUrlFor) {
        expect(provider.catalogUrl).toBeUndefined();
        expect(provider.catalogUrlFor("http://192.168.1.50:11434/v1")).toBe(
          "http://192.168.1.50:11434/v1/models",
        );
        continue;
      }
      expect(provider.catalogUrl).toMatch(/^https:\/\//);
    }
  });

  it("lists with every API key", () => {
    for (const provider of Object.values(LLM_PROVIDERS))
      expect(provider.canList("api-key")).toBe(true);
  });

  it("refuses to list with an OpenAI OAuth blob, whose refresh the gateway owns", () => {
    expect(openai.canList("oauth")).toBe(false);
  });

  it("lists with an Anthropic subscription token, sent as the gateway sends it", () => {
    // A subscription agent must see its subscription's models, not the pinned
    // list: the `sk-ant-oat` setup token is long-lived and needs no refresh.
    expect(anthropic.canList("oauth")).toBe(true);
    expect(anthropic.catalogHeaders("sk-ant-oat-x", "oauth")).toEqual({
      authorization: "Bearer sk-ant-oat-x",
      "anthropic-version": "2023-06-01",
    });
    expect(anthropic.catalogHeaders("sk-ant-api-x", "api-key")).toEqual({
      "x-api-key": "sk-ant-api-x",
      "anthropic-version": "2023-06-01",
    });
  });

  it("registers the OpenAI-compatible pay-your-own-upstream providers", () => {
    for (const [id, label, order, catalogUrl] of [
      ["opencode-go", "OpenCode Go", 2, "https://opencode.ai/zen/go/v1/models"],
      ["openrouter", "OpenRouter", 3, "https://openrouter.ai/api/v1/models"],
    ] as const) {
      const provider = LLM_PROVIDERS[id];
      expect(provider.id).toBe(id);
      expect(provider.label).toBe(label);
      expect(provider.order).toBe(order);
      expect(provider.catalogUrl).toBe(catalogUrl);
      expect(provider.canList("api-key")).toBe(true);
      expect(provider.canList("oauth")).toBe(false);
      expect(provider.catalogHeaders("sk-x", "api-key")).toEqual({
        authorization: "Bearer sk-x",
      });
      expect(provider.fallback.length).toBeGreaterThan(0);
      expect(provider.isSelectable(provider.defaultModel)).toBe(true);
    }
    expect(isLlmProviderId("opencode-go")).toBe(true);
    expect(isLlmProviderId("openrouter")).toBe(true);
  });

  it("opencode-go offers ONLY its OpenAI /chat/completions models", () => {
    const provider = LLM_PROVIDERS["opencode-go"];
    expect(provider.isSelectable("deepseek-v4.1-flash")).toBe(true);
    expect(provider.isSelectable("glm-5.3")).toBe(true);
    // `/responses`- and `/messages`-only models are unsupported by the harness
    // today, so they must not be offered.
    expect(provider.isSelectable("gpt-6-luna")).toBe(false);
    expect(provider.isSelectable("grok-4.7")).toBe(false);
    expect(provider.isSelectable("claude-haiku-5-5")).toBe(false);
    expect(provider.isSelectable("qwen3.8-max")).toBe(false);
  });

  it("registers `local` as the keyless, user-URL OpenAI-compatible provider", () => {
    const provider = LLM_PROVIDERS.local;
    expect(provider.id).toBe("local");
    expect(provider.label).toBe("Local (OpenAI-compatible)");
    expect(provider.order).toBe(4);
    expect(provider.canList("api-key")).toBe(true);
    expect(provider.canList("oauth")).toBe(false);
    expect(provider.canListWithoutKey).toBe(true);
    expect(provider.fallback.length).toBeGreaterThan(0);
    expect(provider.isSelectable(provider.defaultModel)).toBe(true);
    expect(isLlmProviderId("local")).toBe(true);
    // Trailing slashes are trimmed so the catalogue URL never double-slashes.
    expect(provider.catalogUrlFor?.("http://192.168.1.50:11434/v1/")).toBe(
      "http://192.168.1.50:11434/v1/models",
    );
    // A keyless server sends NO auth header; a key is a plain bearer.
    expect(provider.catalogHeaders("", "api-key")).toEqual({});
    expect(provider.catalogHeaders("sk-x", "api-key")).toEqual({
      authorization: "Bearer sk-x",
    });
  });
});

describe("parsing an OpenAI-compatible catalog", () => {
  it("keeps only well-formed id rows for both providers", () => {
    for (const id of ["opencode-go", "openrouter"] as const) {
      expect(
        LLM_PROVIDERS[id].parseCatalog({
          data: [{ id: "model-a" }, { id: "" }, { nope: 1 }, null, "x"],
        }),
      ).toEqual([{ id: "model-a" }]);
    }
  });

  it("drops OpenRouter's non-chat modalities but keeps the vendor models", () => {
    const openrouter = LLM_PROVIDERS.openrouter;
    for (const id of [
      "openai/text-embedding-3-large",
      "openai/whisper-1",
      "openai/dall-e-3",
      "openai/gpt-4o-audio-preview",
      "openai/omni-moderation-latest",
      "openai/gpt-3.5-turbo-instruct",
      "stabilityai/stable-diffusion-xl",
    ])
      expect(openrouter.isSelectable(id)).toBe(false);
    for (const id of [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5.4",
      "google/gemini-3-pro",
      "deepseek/deepseek-v4",
    ])
      expect(openrouter.isSelectable(id)).toBe(true);
  });
});

describe("parsing a provider catalog", () => {
  it("keeps Anthropic's display names and drops malformed rows", () => {
    const parsed = anthropic.parseCatalog({
      data: [
        { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-6" },
        { id: "" },
        { display_name: "no id" },
        null,
        "nonsense",
      ],
    });
    expect(parsed).toEqual([
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6" },
    ]);
  });

  it("survives a body that is not the shape we expect", () => {
    for (const body of [null, undefined, 42, "nope", {}, { data: "no" }]) {
      expect(anthropic.parseCatalog(body)).toEqual([]);
      expect(openai.parseCatalog(body)).toEqual([]);
    }
  });

  it("filters OpenAI's inventory down to models an agent could run", () => {
    // The real /v1/models is the account's whole inventory, most of which a
    // coding agent cannot use.
    const runnable = [
      "gpt-5.4",
      "gpt-5.1-codex",
      "o3",
      "chatgpt-4o-latest",
    ].filter(openai.isSelectable);
    expect(runnable).toEqual([
      "gpt-5.4",
      "gpt-5.1-codex",
      "o3",
      "chatgpt-4o-latest",
    ]);

    for (const id of [
      "text-embedding-3-large",
      "whisper-1",
      "dall-e-3",
      "tts-1",
      "omni-moderation-latest",
      "gpt-4o-realtime-preview",
      "gpt-4o-audio-preview",
      "gpt-4o-transcribe",
      "gpt-3.5-turbo-instruct",
      "babbage-002",
    ])
      expect(openai.isSelectable(id)).toBe(false);
  });

  it("accepts a model that does not exist yet, without a deploy", () => {
    expect(anthropic.isSelectable("claude-opus-7-2")).toBe(true);
    expect(openai.isSelectable("gpt-9")).toBe(true);
  });
});

describe("the catalog cache", () => {
  const provider = anthropic;
  const body = {
    data: [
      { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
    ],
  };
  const ok = () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  beforeEach(() => {
    resetModelCatalogCache();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serves the live list, labelled as the provider named them", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const { models, degraded } = await getModelCatalog(
      provider,
      "sec-1",
      async () => "sk-ant-api-x",
      "api-key",
    );
    expect(degraded).toBe(false);
    expect(models.slice(0, 2).map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
    expect(models.every((m) => m.id !== "")).toBe(true);
  });

  it("offers only the provider's own ids — never a harness alias", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const live = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    resetModelCatalogCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const offline = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );

    // jcode knows `sonnet-4.6` and `sonnet-4.6-thinking`; the control plane
    // must not, or vendor vocabulary has leaked above the adapter (§3.5).
    for (const { models } of [live, offline])
      for (const model of models) expect(model.id).toMatch(/^claude-/);
  });

  it("does not even ASK for the credential when the catalog is warm", async () => {
    // The credential is a thunk because obtaining it costs a KMS decrypt in
    // cloud, and this endpoint is read on every visit to an agent page. A warm
    // cache must spend nothing: quota is account-wide and shared with real
    // secret traffic.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok()));
    const credential = vi.fn().mockResolvedValue("sk-ant-api-x");

    await getModelCatalog(provider, "sec-1", credential, "api-key");
    expect(credential).toHaveBeenCalledTimes(1);

    await getModelCatalog(provider, "sec-1", credential, "api-key");
    await getModelCatalog(provider, "sec-1", credential, "api-key");
    expect(credential).toHaveBeenCalledTimes(1);
  });

  it("never serves one key's catalog to another key", async () => {
    // `/v1/models` is the inventory THAT KEY may use — preview and allowlisted
    // ids included — so a provider-wide entry would show one customer's early
    // access to another, and would let a revoked key's backoff pace everyone.
    const spy = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValue(new Error("that key is revoked"));
    vi.stubGlobal("fetch", spy);

    const first = await getModelCatalog(
      provider,
      "sec-tenant-a",
      async () => "key-a",
      "api-key",
    );
    expect(first.degraded).toBe(false);

    // A different secret must not be answered from the first one's entry, and
    // its own failure must not be recorded against the first one either.
    const second = await getModelCatalog(
      provider,
      "sec-tenant-b",
      async () => "key-b",
      "api-key",
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(second.degraded).toBe(true);

    const again = await getModelCatalog(
      provider,
      "sec-tenant-a",
      async () => "key-a",
      "api-key",
    );
    expect(again.degraded).toBe(false);
  });

  it("makes ONE request for concurrent callers", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);
    await Promise.all([
      getModelCatalog(provider, "sec-1", async () => "k", "api-key"),
      getModelCatalog(provider, "sec-1", async () => "k", "api-key"),
      getModelCatalog(provider, "sec-1", async () => "k", "api-key"),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("serves the pinned list when the very first fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { models, degraded } = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    expect(degraded).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    expect(models.map((m) => m.id)).toContain(provider.defaultModel);
  });

  it("backs off from a COLD failure too, instead of refetching every request", async () => {
    // Cold is the state after every restart, and the permanent state for a
    // self-host with no egress or a revoked key. Without a backoff recorded
    // when nothing is cached, every request would block for the fetch timeout,
    // forever — the same hot loop the warm path already avoids.
    const spy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", spy);
    const credential = vi.fn().mockResolvedValue("k");

    for (let i = 0; i < 5; i++) {
      const { models, degraded } = await getModelCatalog(
        provider,
        "sec-1",
        credential,
        "api-key",
      );
      // Still answered, every time — degraded, never empty.
      expect(degraded).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    }
    expect(spy).toHaveBeenCalledTimes(1);
    // And it does not even pay for a decrypt while suppressed.
    expect(credential).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 1000);
    await getModelCatalog(provider, "sec-1", credential, "api-key");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never asks for a credential it has already decided it cannot use", async () => {
    // An OAuth secret DOES have a decryptable blob, so deciding after the
    // decrypt would burn a KMS call on every request for such an agent.
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);
    const credential = vi.fn().mockResolvedValue("oauth-blob");

    const result = await getModelCatalog(openai, "sec-1", credential, "oauth");
    expect(credential).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("keeps serving a stale list forever rather than emptying the picker", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValue(new Error("provider down"));
    vi.stubGlobal("fetch", spy);

    await getModelCatalog(provider, "sec-1", async () => "k", "api-key");
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    // Stale-while-revalidate answers immediately from what we hold...
    const stale = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    expect(stale.degraded).toBe(true);

    // ...and the failed refresh behind it does not evict anything. Asserted on
    // `source`, not on ids: the pinned fallback contains the same ids, so an
    // id check would pass even if the entry had been dropped.
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const after = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    const sonnet = after.models.find((m) => m.id === "claude-sonnet-4-6");
    expect(sonnet).toMatchObject({
      source: "live",
      label: "Claude Sonnet 4.6",
    });
  });

  it("backs off after a failed refresh instead of retrying on every request", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(ok())
      .mockRejectedValue(new Error("provider down"));
    vi.stubGlobal("fetch", spy);

    await getModelCatalog(provider, "sec-1", async () => "k", "api-key");
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);

    await getModelCatalog(provider, "sec-1", async () => "k", "api-key");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2));

    // Ten more requests during the outage must not become ten more fetches.
    for (let i = 0; i < 10; i++)
      await getModelCatalog(provider, "sec-1", async () => "k", "api-key");
    expect(spy).toHaveBeenCalledTimes(2);

    // Once the backoff elapses, exactly one more attempt is made.
    vi.advanceTimersByTime(6 * 60 * 1000);
    await getModelCatalog(provider, "sec-1", async () => "k", "api-key");
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  });

  it("treats an empty or error response as a failure, not as an empty catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    const empty = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    expect(empty.degraded).toBe(true);
    expect(empty.models.length).toBeGreaterThan(0);

    resetModelCatalogCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 401 })),
    );
    const unauthorized = await getModelCatalog(
      provider,
      "sec-1",
      async () => "k",
      "api-key",
    );
    expect(unauthorized.degraded).toBe(true);
    expect(unauthorized.models.length).toBeGreaterThan(0);
  });

  it("never calls out for a credential that cannot list", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);
    const oauth = await getModelCatalog(
      openai,
      "sec-1",
      async () => "oauth-blob",
      "oauth",
    );
    const none = await getModelCatalog(
      provider,
      "sec-1",
      async () => null,
      "api-key",
    );
    expect(spy).not.toHaveBeenCalled();
    for (const result of [oauth, none]) {
      expect(result.degraded).toBe(true);
      expect(result.models.length).toBeGreaterThan(0);
    }
  });

  it("serves an Anthropic subscription its own live list, fetched with a bearer", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);
    const result = await getModelCatalog(
      provider,
      "sec-oat",
      async () => "sk-ant-oat-x",
      "oauth",
    );
    expect(result.degraded).toBe(false);
    expect(result.models.map((m) => m.id)).toEqual([
      "claude-sonnet-4-6",
      "claude-opus-4-6",
    ]);
    expect(result.models.every((m) => m.source === "live")).toBe(true);
    // Exact headers, so the assertion also proves no `x-api-key` and no beta
    // header rode along.
    expect(spy).toHaveBeenCalledWith(
      provider.catalogUrl,
      expect.objectContaining({
        headers: {
          authorization: "Bearer sk-ant-oat-x",
          "anthropic-version": "2023-06-01",
        },
      }),
    );
  });

  it("falls back to the pinned list when a subscription token is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 403 })),
    );
    const result = await getModelCatalog(
      provider,
      "sec-oat",
      async () => "sk-ant-oat-x",
      "oauth",
    );
    expect(result.degraded).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([...provider.fallback]);
  });

  it("fetches a `local` server's catalog from its OWN base URL, even keyless", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    const result = await getModelCatalog(
      local,
      "sec-local",
      async () => null,
      "api-key",
      "http://192.168.1.50:11434/v1",
    );

    expect(spy).toHaveBeenCalledWith(
      "http://192.168.1.50:11434/v1/models",
      expect.objectContaining({ headers: {} }),
    );
    expect(result.degraded).toBe(false);
    expect(result.models.every((m) => m.source === "live")).toBe(true);
  });

  it("degrades a `local` catalog to the pinned list when no base URL is known", async () => {
    const spy = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", spy);

    const result = await getModelCatalog(
      local,
      "sec-local",
      async () => null,
      "api-key",
      null,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(result.degraded).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([...local.fallback]);
  });
});

describe("resolving what an agent runs", () => {
  const none = { model: null, effort: null, modelProvider: null };

  it("falls back to the provider's default when nothing is overridden", () => {
    expect(resolveAgentModel(none, "anthropic")).toEqual({
      model: anthropic.defaultModel,
      overridden: false,
    });
  });

  it("uses the override when it belongs to this provider", () => {
    expect(
      resolveAgentModel(
        {
          model: "claude-opus-4-6",
          effort: "high",
          modelProvider: "anthropic",
        },
        "anthropic",
      ),
    ).toEqual({ model: "claude-opus-4-6", effort: "high", overridden: true });
  });

  it("IGNORES an override stamped for a different provider", () => {
    // The write path clears it; reading defensively means a missed clear
    // degrades to the default instead of sending a foreign id to the harness.
    expect(
      resolveAgentModel(
        {
          model: "claude-opus-4-6",
          effort: "high",
          modelProvider: "anthropic",
        },
        "openai",
      ),
    ).toEqual({ model: openai.defaultModel, overridden: false });
  });

  it("allows effort alone, keeping the default model", () => {
    expect(
      resolveAgentModel(
        { model: null, effort: "max", modelProvider: "anthropic" },
        "anthropic",
      ),
    ).toEqual({
      model: anthropic.defaultModel,
      effort: "max",
      overridden: true,
    });
  });

  it("drops an effort level this provider cannot express", () => {
    expect(
      resolveAgentModel(
        // "xhigh" is a level some harnesses have and our scale does not.
        { model: null, effort: "xhigh", modelProvider: "anthropic" },
        "anthropic",
      ).effort,
    ).toBeUndefined();
  });
});
