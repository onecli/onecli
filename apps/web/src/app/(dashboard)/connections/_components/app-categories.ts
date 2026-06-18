export type AppCategory =
  | "google"
  | "microsoft"
  | "development"
  | "project-management"
  | "cloud-data"
  | "communication";

export const CATEGORY_LABELS: { id: AppCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "development", label: "Development" },
  { id: "google", label: "Google" },
  { id: "microsoft", label: "Microsoft" },
  { id: "project-management", label: "Project Management" },
  { id: "cloud-data", label: "Cloud & Data" },
  { id: "communication", label: "Communication" },
];

export const APP_CATEGORIES: Record<string, AppCategory> = {
  // Google
  gmail: "google",
  "google-drive": "google",
  "google-calendar": "google",
  "google-contacts": "google",
  "google-docs": "google",
  "google-sheets": "google",
  "google-slides": "google",
  "google-forms": "google",
  "google-meet": "google",
  "google-photos": "google",
  "google-tasks": "google",
  "google-admin": "google",
  "google-classroom": "google",
  "google-search-console": "google",
  "google-analytics": "google",
  youtube: "google",

  // Microsoft
  "outlook-mail": "microsoft",
  "outlook-calendar": "microsoft",
  "microsoft-word": "microsoft",
  "microsoft-onenote": "microsoft",

  // Development
  github: "development",
  "github-app": "development",
  docker: "development",
  vercel: "development",
  cloudflare: "development",
  flyio: "development",
  sentry: "development",
  linear: "development",

  // Project Management
  jira: "project-management",
  confluence: "project-management",
  notion: "project-management",
  todoist: "project-management",
  trello: "project-management",
  monday: "project-management",

  // Cloud & Data
  aws: "cloud-data",
  "aws-role": "cloud-data",
  supabase: "cloud-data",
  "mongodb-atlas": "cloud-data",
  dropbox: "cloud-data",
  datadog: "cloud-data",
  "vertex-ai": "cloud-data",

  // Communication
  resend: "communication",
  linkedin: "communication",
  zoom: "communication",
  hubspot: "communication",
  affinity: "communication",
  granola: "communication",
};
