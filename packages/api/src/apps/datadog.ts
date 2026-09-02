import type { AppDefinition } from "./types";

const datadogHostForSite = (site: string): string => {
  const s = site.trim().toLowerCase();
  if (s === "eu" || s === "eu1") return "api.datadoghq.eu";
  if (!s || s === "us1") return "api.datadoghq.com";
  return `api.${s}.datadoghq.com`;
};

const datadogSiteUrl = (site: string): string => {
  const s = site.trim().toLowerCase();
  if (s === "eu" || s === "eu1") return "https://app.datadoghq.eu";
  if (!s || s === "us1") return "https://app.datadoghq.com";
  return `https://${s}.datadoghq.com`;
};

const resolveMetadata = async (
  fields: Record<string, string>,
): Promise<Record<string, unknown> | null> => {
  const site = fields.site ?? "us1";
  const host = datadogHostForSite(site);
  const siteLabel = site.trim().toUpperCase() || "US1";
  const url = datadogSiteUrl(site);

  try {
    const res = await fetch(`https://${host}/api/v1/org`, {
      headers: {
        "DD-API-KEY": fields.apiKey ?? "",
        "DD-APPLICATION-KEY": fields.appKey ?? "",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        orgs?: Array<{ name?: string }>;
      };
      const orgName = data.orgs?.[0]?.name;
      if (orgName)
        return { name: `${orgName} (${siteLabel})`, url, tags: [siteLabel] };
    }
  } catch {
    // Fall through to site label
  }

  return { name: siteLabel, url, tags: [siteLabel] };
};

export const datadog: AppDefinition = {
  id: "datadog",
  name: "Datadog",
  icon: "/icons/datadog.svg",
  darkIcon: "/icons/datadog-light.svg",
  description: "Monitoring, APM, logs, and infrastructure metrics.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "appKey",
        label: "Application Key",
        description: "Your Datadog Application key",
        placeholder: "Enter Application Key",
      },
      {
        name: "apiKey",
        label: "API Key",
        description: "Your Datadog API key",
        placeholder: "Enter API Key",
      },
      {
        name: "site",
        label: "Datadog Site",
        description:
          "The Datadog site for your account (e.g., us1, us3, us5, eu, ap1)",
        placeholder: "us1",
        secret: false,
      },
    ],
    resolveMetadata,
  },
};
