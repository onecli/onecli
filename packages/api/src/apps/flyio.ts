import type { AppDefinition } from "./types";

export const flyio: AppDefinition = {
  id: "flyio",
  name: "Fly.io",
  icon: "/icons/flyio.svg",
  description:
    "Deploy and manage applications, Machines, volumes, and secrets on Fly.io.",
  connectionMethod: {
    type: "api_key",
    fields: [
      {
        name: "apiToken",
        label: "API Token",
        description:
          "Your Fly.io token. Create one at fly.io/dashboard or run fly tokens create org",
        placeholder: "FlyV1 fm2_...",
      },
    ],
  },
  available: true,
};
