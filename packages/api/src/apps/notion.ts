import type { AppDefinition } from "./types";

const NOTION_ICON_MAP: Record<string, string> = {
  compass: "\u{1F9ED}",
  bullseye: "\u{1F3AF}",
  checklist: "\u{2705}",
  document: "\u{1F4C4}",
  notebook: "\u{1F4D3}",
  calendar: "\u{1F4C5}",
  chat: "\u{1F4AC}",
  folder: "\u{1F4C1}",
  star: "\u{2B50}",
  heart: "\u{2764}\u{FE0F}",
  lightning: "\u{26A1}",
  fire: "\u{1F525}",
  globe: "\u{1F30D}",
  lock: "\u{1F512}",
  megaphone: "\u{1F4E3}",
  palette: "\u{1F3A8}",
  puzzle: "\u{1F9E9}",
  rocket: "\u{1F680}",
  settings: "\u{2699}\u{FE0F}",
  shield: "\u{1F6E1}\u{FE0F}",
  trophy: "\u{1F3C6}",
  warning: "\u{26A0}\u{FE0F}",
  wrench: "\u{1F527}",
  book: "\u{1F4D6}",
  briefcase: "\u{1F4BC}",
  camera: "\u{1F4F7}",
  chart: "\u{1F4CA}",
  clock: "\u{1F552}",
  code: "\u{1F4BB}",
  email: "\u{2709}\u{FE0F}",
  flag: "\u{1F3F3}\u{FE0F}",
  home: "\u{1F3E0}",
  key: "\u{1F511}",
  link: "\u{1F517}",
  map: "\u{1F5FA}\u{FE0F}",
  music: "\u{1F3B5}",
  people: "\u{1F465}",
  phone: "\u{1F4F1}",
  pin: "\u{1F4CC}",
  search: "\u{1F50D}",
  tag: "\u{1F3F7}\u{FE0F}",
  video: "\u{1F3AC}",
};

interface NotionSearchResult {
  id?: string;
  object?: string;
  parent?: { type?: string };
  icon?: {
    type?: string;
    emoji?: string;
    external?: { url?: string };
    file?: { url?: string };
    icon?: { name?: string; color?: string };
  } | null;
  properties?: Record<
    string,
    { type?: string; title?: { plain_text?: string }[] }
  >;
  child_page?: { title?: string };
  title?: { plain_text?: string }[];
  url?: string;
  last_edited_time?: string;
}

const resolveTitle = (r: NotionSearchResult): string => {
  if (r.object === "database" && r.title?.length) {
    return r.title.map((t) => t.plain_text ?? "").join("");
  }
  if (r.properties) {
    const titleProp = Object.values(r.properties).find(
      (p) => p.type === "title",
    );
    if (titleProp?.title?.length) {
      return titleProp.title.map((t) => t.plain_text ?? "").join("");
    }
  }
  return r.child_page?.title ?? "";
};

const resolveIcon = (r: NotionSearchResult): string | null => {
  if (r.icon?.type === "emoji") return r.icon.emoji ?? null;
  if (r.icon?.type === "external") return r.icon.external?.url ?? null;
  if (r.icon?.type === "file") return r.icon.file?.url ?? null;
  if (r.icon?.type === "icon" && r.icon.icon?.name) {
    return NOTION_ICON_MAP[r.icon.icon.name] ?? "\u{1F4C4}";
  }
  return null;
};

const fetchAccessiblePages = async (
  accessToken: string,
): Promise<{ name: string; icon: string | null; url: string | null }[]> => {
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 50 }),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as { results?: NotionSearchResult[] };
  const seen = new Set<string>();
  const pages: {
    name: string;
    icon: string | null;
    url: string | null;
    editedAt: number;
  }[] = [];

  for (const r of data.results ?? []) {
    if (r.parent?.type !== "workspace") continue;
    const name = resolveTitle(r);
    if (!name || (r.id && seen.has(r.id))) continue;
    if (r.id) seen.add(r.id);

    pages.push({
      name,
      icon: resolveIcon(r),
      url: r.url ?? null,
      editedAt: r.last_edited_time ? new Date(r.last_edited_time).getTime() : 0,
    });
  }

  pages.sort((a, b) => b.editedAt - a.editedAt);

  return pages.map(({ name, icon, url }) => ({ name, icon, url }));
};

export const notion: AppDefinition = {
  id: "notion",
  name: "Notion",
  icon: "/icons/notion.svg",
  darkIcon: "/icons/notion-light.svg",
  description: "Pages, databases, comments, and workspace content.",
  connectionMethod: {
    type: "oauth",
    defaultScopes: [],
    permissions: [
      {
        scope: "read_content",
        name: "Pages & databases",
        description: "Read pages, databases, and blocks",
        access: "read",
      },
      {
        scope: "update_content",
        name: "Content",
        description: "Create and update pages and blocks",
        access: "write",
      },
      {
        scope: "read_comments",
        name: "Comments",
        description: "Read and create comments",
        access: "write",
      },
      {
        scope: "read_user",
        name: "User info",
        description: "Name, email, and avatar",
        access: "read",
      },
    ],
    buildAuthUrl: ({ appCredentials, redirectUri, state }) => {
      const url = new URL("https://api.notion.com/v1/oauth/authorize");
      url.searchParams.set("client_id", appCredentials.clientId!);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("owner", "user");
      url.searchParams.set("state", state);
      return url.toString();
    },
    exchangeCode: async ({ appCredentials, callbackParams, redirectUri }) => {
      const basicAuth = Buffer.from(
        `${appCredentials.clientId}:${appCredentials.clientSecret}`,
      ).toString("base64");

      const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: callbackParams.code!,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        throw new Error(
          `Notion token exchange failed: ${tokenRes.status} ${tokenRes.statusText}`,
        );
      }

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        bot_id?: string;
        workspace_id?: string;
        workspace_name?: string;
        workspace_icon?: string;
        owner?: {
          type?: string;
          user?: {
            id?: string;
            name?: string;
            avatar_url?: string;
            person?: { email?: string };
          };
        };
        error?: string;
      };

      if (tokenData.error || !tokenData.access_token) {
        throw new Error(
          (tokenData as Record<string, string>).error ??
            "Failed to exchange code for token",
        );
      }

      const expiresIn =
        (tokenData as { expires_in?: number }).expires_in ?? 3600;
      const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

      const credentials: Record<string, unknown> = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type,
        expires_at: expiresAt,
      };

      let pages: { name: string; icon: string | null; url: string | null }[] =
        [];
      try {
        pages = await fetchAccessiblePages(tokenData.access_token);
      } catch {
        // Non-fatal — pages metadata is optional
      }

      const user = tokenData.owner?.user;
      const metadata: Record<string, unknown> = {
        username: user?.person?.email ?? user?.name,
        email: user?.person?.email,
        name: user?.name,
        avatarUrl: user?.avatar_url,
        workspaceName: tokenData.workspace_name,
        workspaceId: tokenData.workspace_id,
        pages,
      };

      const scopes = [
        "read_content",
        "update_content",
        "read_comments",
        "read_user",
      ];

      return { credentials, scopes, metadata };
    },
  },
  available: true,
  configurable: {
    hint: "Create a public integration at notion.so/profile/integrations.",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "secret_...",
        secret: true,
      },
    ],
    envDefaults: {
      clientId: "NOTION_CLIENT_ID",
      clientSecret: "NOTION_CLIENT_SECRET",
    },
  },
};
