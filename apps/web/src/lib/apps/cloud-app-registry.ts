import type { AppDefinition } from "./types";

export const cloudApps: AppDefinition[] = [
  {
    id: "github-app",
    name: "GitHub App",
    icon: "/icons/github.svg",
    darkIcon: "/icons/github-light.svg",
    description:
      "Fine-grained, org-approved access to repositories and resources.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "datadog",
    name: "Datadog",
    icon: "/icons/datadog.svg",
    description: "Monitoring, APM, logs, and infrastructure metrics.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "outlook-mail",
    name: "Outlook Mail",
    icon: "/icons/outlook-mail.svg",
    description: "Read, compose, and send emails via Microsoft Outlook.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "outlook-calendar",
    name: "Outlook Calendar",
    icon: "/icons/outlook-calendar.svg",
    description: "View and manage calendar events in Microsoft Outlook.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "microsoft-word",
    name: "Microsoft Word",
    icon: "/icons/microsoft-word.svg",
    description:
      "Read and edit Word documents stored in OneDrive and SharePoint.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
];
