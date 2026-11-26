"use client";

import { AppIcon } from "@/lib/components/app-icon";
import { cn } from "@onecli/ui/lib/utils";

interface Logo {
  name: string;
  icon: string;
  /** The light-on-dark variant, for marks that vanish on a dark card. */
  darkIcon?: string;
}

/** Three rows of everyday work apps people recognise on sight, drifting in
 * alternating directions at slightly different speeds so the grid feels
 * alive without any one row pulling the eye. */
const ROWS: { logos: Logo[]; duration: string; reverse: boolean }[] = [
  {
    duration: "46s",
    reverse: false,
    logos: [
      { name: "HubSpot", icon: "/icons/hubspot.svg" },
      { name: "Salesforce", icon: "/icons/salesforce.svg" },
      { name: "Stripe", icon: "/icons/stripe.svg" },
      { name: "monday.com", icon: "/icons/monday.svg" },
      { name: "Trello", icon: "/icons/trello.svg" },
      { name: "Dropbox", icon: "/icons/dropbox.svg" },
      { name: "Todoist", icon: "/icons/todoist.svg" },
      { name: "Zoom", icon: "/icons/zoom.svg" },
      { name: "Airtable", icon: "/icons/airtable.svg" },
      {
        name: "Attio",
        icon: "/icons/attio.svg",
        darkIcon: "/icons/attio-light.svg",
      },
      { name: "Apollo.io", icon: "/icons/apollo-io.svg" },
      { name: "Pylon", icon: "/icons/pylon.svg" },
      { name: "Twilio", icon: "/icons/twilio.svg" },
      { name: "LinkedIn", icon: "/icons/linkedin.svg" },
    ],
  },
  {
    duration: "40s",
    reverse: true,
    logos: [
      { name: "Gmail", icon: "/icons/gmail.svg" },
      { name: "Google Calendar", icon: "/icons/google-calendar.svg" },
      { name: "Google Drive", icon: "/icons/google-drive.svg" },
      { name: "Slack", icon: "/icons/slack.svg" },
      {
        name: "Notion",
        icon: "/icons/notion.svg",
        darkIcon: "/icons/notion-light.svg",
      },
      {
        name: "Linear",
        icon: "/icons/linear.svg",
        darkIcon: "/icons/linear-light.svg",
      },
      { name: "Outlook", icon: "/icons/outlook-mail.svg" },
      { name: "Microsoft Teams", icon: "/icons/microsoft-teams.svg" },
      { name: "Outlook Calendar", icon: "/icons/outlook-calendar.svg" },
      { name: "Google Meet", icon: "/icons/google-meet.svg" },
      { name: "Granola", icon: "/icons/granola.svg" },
      { name: "Microsoft Word", icon: "/icons/microsoft-word.svg" },
      { name: "Google Contacts", icon: "/icons/google-contacts.svg" },
      { name: "YouTube", icon: "/icons/youtube.svg" },
    ],
  },
  {
    duration: "52s",
    reverse: false,
    logos: [
      {
        name: "GitHub",
        icon: "/icons/github.svg",
        darkIcon: "/icons/github-light.svg",
      },
      { name: "Jira", icon: "/icons/jira.svg" },
      { name: "Confluence", icon: "/icons/confluence.svg" },
      { name: "Google Docs", icon: "/icons/google-docs.svg" },
      { name: "Google Sheets", icon: "/icons/google-sheets.svg" },
      { name: "Webflow", icon: "/icons/webflow.svg" },
      { name: "Zoho CRM", icon: "/icons/zoho-crm.svg" },
      { name: "Supabase", icon: "/icons/supabase.svg" },
      {
        name: "Sentry",
        icon: "/icons/sentry.svg",
        darkIcon: "/icons/sentry-light.svg",
      },
      {
        name: "PostHog",
        icon: "/icons/posthog.svg",
        darkIcon: "/icons/posthog-light.svg",
      },
      {
        name: "Datadog",
        icon: "/icons/datadog.svg",
        darkIcon: "/icons/datadog-light.svg",
      },
      { name: "PagerDuty", icon: "/icons/pagerduty.svg" },
      { name: "Snowflake", icon: "/icons/snowflake.svg" },
      { name: "Google Slides", icon: "/icons/google-slides.svg" },
    ],
  },
];

/** A thin fade only at the very edges, so tiles slide in and out softly
 * without a wide band of washed-out logos. */
const EDGE_FADE =
  "linear-gradient(to right, transparent, black 5%, black 95%, transparent)";

/**
 * "Works with all your tools" as one picture: rows of app tiles sliding past.
 * Each row holds 14 different apps, wider than the frame, so no app ever
 * shows twice on screen at once; the row renders its list twice and slides
 * by half its width (`animate-marquee`) for a seamless loop. Decorative only
 * (aria-hidden), and still for anyone who prefers reduced motion.
 */
export const AppsMarquee = ({ className }: { className?: string }) => (
  <div
    aria-hidden="true"
    data-testid="apps-marquee"
    className={cn(
      "flex w-full max-w-2xl flex-col gap-3 overflow-hidden select-none",
      className,
    )}
    style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
  >
    {ROWS.map((row, r) => (
      <div
        key={r}
        className="motion-safe:animate-marquee flex w-max"
        style={{
          animationDuration: row.duration,
          animationDirection: row.reverse ? "reverse" : "normal",
        }}
      >
        {[...row.logos, ...row.logos].map((logo, i) => (
          <div key={`${logo.name}-${i}`} className="pr-3">
            <div className="bg-card flex size-16 items-center justify-center rounded-2xl border shadow-xs">
              <AppIcon
                icon={logo.icon}
                darkIcon={logo.darkIcon}
                name={logo.name}
                size={32}
                loading="eager"
              />
            </div>
          </div>
        ))}
      </div>
    ))}
  </div>
);
