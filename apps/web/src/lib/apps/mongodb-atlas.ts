import type { AppDefinition, OAuthExchangeResult } from "./types";
import { exchangeClientCredentials } from "./oauth/client-credentials";

const ATLAS_TOKEN_URL = "https://cloud.mongodb.com/api/oauth/token";

const exchangeCredentials = async (
  fields: Record<string, string>,
): Promise<OAuthExchangeResult> => {
  const { clientId, clientSecret } = fields;

  if (!clientId || !clientSecret) {
    throw new Error("Client ID and Client Secret are required");
  }

  const { credentials, accessToken } = await exchangeClientCredentials({
    tokenUrl: ATLAS_TOKEN_URL,
    clientId,
    clientSecret,
  });

  let metadata: Record<string, unknown> | undefined;
  const orgsRes = await fetch("https://cloud.mongodb.com/api/atlas/v2/orgs", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.atlas.2023-01-01+json",
    },
  });

  if (orgsRes.ok) {
    const orgsData = (await orgsRes.json()) as {
      results?: { id: string; name: string }[];
    };
    const org = orgsData.results?.[0];
    if (org) {
      metadata = { name: org.name, orgId: org.id };
    }
  }

  return { credentials, scopes: [], metadata };
};

export const mongodbAtlas: AppDefinition = {
  id: "mongodb-atlas",
  name: "MongoDB Atlas",
  icon: "/icons/mongodb-atlas.svg",
  description:
    "Manage clusters, users, and projects via the Atlas Administration API.",
  connectionMethod: {
    type: "credentials_import",
    fields: [
      {
        name: "clientId",
        label: "Client ID",
        placeholder: "mdb_sa_id_...",
        secret: false,
      },
      {
        name: "clientSecret",
        label: "Client Secret",
        placeholder: "mdb_sa_sk_...",
        secret: true,
      },
    ],
    exchangeCredentials,
  },
  available: true,
};
