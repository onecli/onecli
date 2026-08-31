import { describe, expect, it } from "vitest";
import {
  agentAppDescription,
  agentAppDescriptionWithOwner,
  BOT_SCOPES,
  botScopesFor,
  buildAgentManifest,
  tombstoneAppName,
  withAppName,
  withSyncedAppName,
  withTombstoneName,
} from "./manifest";

/**
 * The generated Slack manifest — pure functions, no DB, no HTTP. What is
 * pinned here is exactly what Slack validates (or silently punishes): scope
 * SPELLINGS, the scope set both grant surfaces share, and the documented
 * display caps.
 */

describe("BOT_SCOPES", () => {
  it("pins the exact docs-verified scope list, character for character", () => {
    // MUTATION-TESTED, byte for byte: `app_mentions:read` takes a COLON —
    // the docs-site URL slug spells it with a dot, and that spelling fails
    // manifest validation, killing the install outright. `users:read.email`
    // is the ONE genuine dot. And `channels:read` + `groups:read` gate
    // `member_joined_channel` DELIVERY: drop either and the invite door
    // silently never hears the event — no manifest-validation error warns
    // about it, so this list is the only guard.
    expect([...BOT_SCOPES]).toEqual([
      "chat:write",
      "chat:write.customize",
      "im:history",
      "im:write",
      "app_mentions:read",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "reactions:write",
      "files:read",
      "users:read",
      "users:read.email",
    ]);
  });
});

describe("botScopesFor", () => {
  it("regular = exactly BOT_SCOPES; agent = BOT_SCOPES + assistant:write", () => {
    // `assistant:write` is what Slack requires to declare `agent_view`. The
    // regular arm exists for PRE-EXISTING apps only: a pending regular
    // attach resumed after the agent-only switch must mint a consent URL
    // granting exactly the scopes its remote manifest declared — asking for
    // `assistant:write` there would confuse admins reviewing the grant.
    expect(botScopesFor("regular")).toEqual([...BOT_SCOPES]);
    expect(botScopesFor("agent")).toEqual([...BOT_SCOPES, "assistant:write"]);
  });
});

describe("the app_home messages tab", () => {
  it("is enabled and writable in every generated manifest — without it Slack disables the DM composer entirely", () => {
    // Caught live on the first real DM: scopes and `message.im` alone do NOT
    // open the composer; this block is what does.
    for (const transport of ["socket", "events"] as const) {
      const manifest = buildAgentManifest({
        agentName: "lany",
        transport,
        publicApiUrl: transport === "events" ? "https://api.example.com" : null,
      });
      expect((manifest.features as Record<string, unknown>).app_home).toEqual({
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      });
    }
  });
});

describe("buildAgentManifest", () => {
  it("bakes the FULL agent scope list into oauth_config — the manifest is a grant surface", () => {
    // The other grant surface is the provider's rebuilt authorize URL; the
    // pg suite pins that one to botScopesFor(appMode).join(","). Both must
    // carry the whole list or the installed bot is missing capabilities.
    const manifest = buildAgentManifest({
      agentName: "Deploy Agent",
      transport: "socket",
      publicApiUrl: null,
    }) as { oauth_config: { scopes: { bot: string[] } } };
    expect(manifest.oauth_config.scopes.bot).toEqual([
      ...BOT_SCOPES,
      "assistant:write",
    ]);
  });

  it("always declares agent_view with a description and asks for assistant:write", () => {
    // `agent_view` without `agent_description` fails manifest validation;
    // `agent_view` without `assistant:write` does too. The pair is what
    // makes the app a Slack agent (the sessions loader UX) — IRREVERSIBLE
    // per app, and since the agent-only switch, baked into every new app.
    const manifest = buildAgentManifest({
      agentName: "Deploy Agent",
      transport: "socket",
      publicApiUrl: null,
    }) as {
      features: { agent_view?: { agent_description: string } };
      oauth_config: { scopes: { bot: string[] } };
    };
    expect(manifest.features.agent_view).toEqual({
      agent_description: "Deploy Agent, a OneCLI hosted agent",
    });
    expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
  });

  it("keeps agent_description inside Slack's 300-char cap for a max-length name", () => {
    const manifest = buildAgentManifest({
      agentName: "A".repeat(80),
      transport: "socket",
      publicApiUrl: null,
    }) as { features: { agent_view: { agent_description: string } } };
    expect(
      manifest.features.agent_view.agent_description.length,
    ).toBeLessThanOrEqual(300);
  });

  it("keeps the display fields inside Slack's documented caps (name 35, description 140)", () => {
    // The manifest reference caps description at 140 — NOT the 175 the app
    // dashboard shows — and an over-cap manifest fails apps.manifest.create.
    const manifest = buildAgentManifest({
      agentName: "A".repeat(80),
      transport: "socket",
      publicApiUrl: null,
    }) as { display_information: { name: string; description: string } };
    expect(manifest.display_information.name.length).toBeLessThanOrEqual(35);
    expect(manifest.display_information.description.length).toBeLessThanOrEqual(
      140,
    );
    expect(manifest.display_information.description).toContain(
      "a OneCLI hosted agent",
    );
  });

  it("refuses an events manifest with no public API URL — a programming error, loudly", () => {
    expect(() =>
      buildAgentManifest({
        agentName: "x",
        transport: "events",
        publicApiUrl: null,
      }),
    ).toThrow("events transport requires a public API URL");
  });
});

/** An exported-manifest fixture with fields the rename must NEVER touch. */
const exported = (over?: Record<string, unknown>) => ({
  display_information: {
    name: "old-name",
    description: "keep me",
    background_color: "#000000",
  },
  features: {
    app_home: { messages_tab_enabled: true },
    bot_user: { display_name: "old-name", always_online: true },
  },
  oauth_config: { scopes: { bot: ["chat:write"] } },
  settings: { socket_mode_enabled: true },
  ...over,
});

describe("withAppName", () => {
  it("replaces BOTH name fields and nothing else — scopes, URLs, description untouched", () => {
    const out = withAppName(exported(), "New Name") as {
      display_information: Record<string, unknown>;
      features: { bot_user: Record<string, unknown> };
      oauth_config: unknown;
      settings: unknown;
    };
    expect(out.display_information.name).toBe("New Name");
    expect(out.features.bot_user.display_name).toBe("New Name");
    expect(out.features.bot_user.always_online).toBe(true);
    expect(out.display_information.description).toBe("keep me");
    expect(out.display_information.background_color).toBe("#000000");
    expect(out.oauth_config).toEqual({ scopes: { bot: ["chat:write"] } });
    expect(out.settings).toEqual({ socket_mode_enabled: true });
  });

  it("clamps a long name to 35 with the ellipsis, and falls back on an empty one", () => {
    const long = withAppName(exported(), "N".repeat(50)) as {
      display_information: { name: string };
    };
    expect(long.display_information.name).toHaveLength(35);
    expect(long.display_information.name.endsWith("…")).toBe(true);
    const empty = withAppName(exported(), "   ") as {
      display_information: { name: string };
    };
    expect(empty.display_information.name).toBe("OneCLI agent");
  });
});

describe("withTombstoneName", () => {
  it("is exactly withAppName with the tombstone name — byte-identical", () => {
    expect(withTombstoneName(exported(), "A0XYZ")).toEqual(
      withAppName(exported(), tombstoneAppName("A0XYZ")),
    );
  });
});

describe("withSyncedAppName", () => {
  it("moves the GENERATED description with the rename — the About text embeds the old name", () => {
    const manifest = exported({
      display_information: {
        name: "old-name",
        description: agentAppDescription("old-name"),
      },
    });
    const out = withSyncedAppName(manifest, "New Name") as {
      display_information: { name: string; description: string };
    };
    expect(out.display_information.name).toBe("New Name");
    expect(out.display_information.description).toBe(
      agentAppDescription("New Name"),
    );
  });

  it("preserves a CUSTOMIZED description — only the generated template moves", () => {
    const out = withSyncedAppName(exported(), "New Name") as {
      display_information: { name: string; description: string };
    };
    expect(out.display_information.name).toBe("New Name");
    expect(out.display_information.description).toBe("keep me");
  });

  it("keeps the refreshed description inside the 140 cap for a max-length name", () => {
    const manifest = exported({
      display_information: {
        name: "old-name",
        description: agentAppDescription("old-name"),
      },
    });
    const out = withSyncedAppName(manifest, "N".repeat(80)) as {
      display_information: { description: string };
    };
    expect(out.display_information.description.length).toBeLessThanOrEqual(140);
    expect(out.display_information.description).toContain(
      "a OneCLI hosted agent",
    );
  });

  it("carries the Managed-by owner suffix through a rename", () => {
    const manifest = exported({
      display_information: {
        name: "old-name",
        description: agentAppDescriptionWithOwner("old-name", {
          name: "Jonathan",
          email: "jonathan@onecli.sh",
        }),
      },
    });
    const out = withSyncedAppName(manifest, "New Name") as {
      display_information: { description: string };
    };
    expect(out.display_information.description).toBe(
      "New Name, a OneCLI hosted agent. Managed by Jonathan (jonathan@onecli.sh).",
    );
  });
});

describe("agentAppDescriptionWithOwner", () => {
  it("names the owner with their email", () => {
    expect(
      agentAppDescriptionWithOwner("Donna", {
        name: "Jonathan",
        email: "jonathan@onecli.sh",
      }),
    ).toBe(
      "Donna, a OneCLI hosted agent. Managed by Jonathan (jonathan@onecli.sh).",
    );
  });

  it("falls back to the bare email when the owner has no display name", () => {
    expect(
      agentAppDescriptionWithOwner("Donna", {
        name: null,
        email: "jonathan@onecli.sh",
      }),
    ).toBe("Donna, a OneCLI hosted agent. Managed by jonathan@onecli.sh.");
  });

  it("sacrifices the owner suffix, never the identity line, at the 140 cap", () => {
    const long = agentAppDescriptionWithOwner("N".repeat(34), {
      name: "A very long name that overflows the app description budget",
      email: "very-long-address@example-company-domain.com",
    });
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toContain("a OneCLI hosted agent");
    expect(long).not.toContain("Managed by");
  });
});
