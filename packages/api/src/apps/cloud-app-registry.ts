import type { AppDefinition } from "./types";

export const cloudApps: AppDefinition[] = [
  {
    id: "datadog",
    name: "Datadog",
    icon: "/icons/datadog.svg",
    darkIcon: "/icons/datadog-light.svg",
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
  {
    id: "microsoft-onenote",
    name: "Microsoft OneNote",
    icon: "/icons/microsoft-onenote.svg",
    description:
      "Read and manage notebooks, sections, and pages in Microsoft OneNote.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "aws-role",
    name: "AWS Role",
    icon: "/icons/aws.svg",
    darkIcon: "/icons/aws-light.svg",
    description:
      "Connect via IAM AssumeRole with temporary credentials and per-agent permissions.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "affinity",
    name: "Affinity",
    icon: "/icons/affinity.svg",
    description:
      "Manage relationships, deals, and interactions in Affinity CRM.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
  {
    id: "zoom",
    name: "Zoom",
    icon: "/icons/zoom.svg",
    description: "Meetings, webinars, and cloud recordings.",
    connectionMethod: { type: "cloud_only" },
    available: false,
  },
];
