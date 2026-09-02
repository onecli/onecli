"use client";

import { ExternalLink, TriangleAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@onecli/ui/components/popover";

/** "limit or key problem" in one short badge: what + when. The service only
 * surfaces statuses that indict the key (401/402/403/429); the fallback stays
 * in case that set ever widens. */
const lastErrorLabel = (status: number): string => {
  if (status === 429) return "Rate limited";
  if (status === 401 || status === 403) return "Key rejected";
  if (status === 402) return "Billing issue";
  return "Provider error";
};

/**
 * Where to FIX the problem, on the provider's own console: an auth failure
 * (401/403) points at the key management page, anything else (limits,
 * billing-driven 402/429) at the billing page. Keyed by the secret's type —
 * only providers we can name get a link.
 */
const providerFixLink = (
  type: string,
  status: number,
): { href: string; label: string } | undefined => {
  const auth = status === 401 || status === 403;
  if (type === "anthropic") {
    return auth
      ? {
          href: "https://platform.claude.com/settings/keys",
          label: "Manage Anthropic keys",
        }
      : {
          href: "https://platform.claude.com/settings/billing",
          label: "Anthropic billing & limits",
        };
  }
  if (type === "openai") {
    return auth
      ? {
          href: "https://platform.openai.com/api-keys",
          label: "Manage OpenAI keys",
        }
      : {
          href: "https://platform.openai.com/settings/organization/billing/overview",
          label: "OpenAI billing & limits",
        };
  }
  return undefined;
};

/** Compact "3h ago" style — the badge rides an already-busy metadata line. */
const timeAgo = (iso: string): string => {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export interface KeyHealthBadgeProps {
  /** The secret's type — only providers we can name get a fix link. */
  type: string;
  lastError: { status: number; at: string };
}

/**
 * The key's recent health, click-to-explain. A Popover rather than a Tooltip
 * so the provider-console fix link is keyboard-reachable (Enter opens, Tab
 * reaches the link) — the house pattern for interactive explanatory content.
 */
export const KeyHealthBadge = ({ type, lastError }: KeyHealthBadgeProps) => {
  const fix = providerFixLink(type, lastError.status);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          // Negative-margin padding widens the tap target (the only route to
          // the fix link) past the bare 16px text line without shifting the
          // metadata row's layout.
          className="focus-visible:ring-ring/50 -mx-1 -my-1.5 flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-1.5 text-amber-600 outline-none hover:text-amber-700 focus-visible:ring-[3px] dark:text-amber-500 dark:hover:text-amber-400"
        >
          <TriangleAlert className="size-3" aria-hidden />
          {/* Underline on an inner span: text-decoration does not propagate
              into flex items, so it would vanish on the flex button. */}
          <span className="underline decoration-dotted underline-offset-2">
            {lastErrorLabel(lastError.status)} · {timeAgo(lastError.at)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3 text-xs">
        The provider answered the last request with HTTP {lastError.status}.
        Usually a usage limit, a billing problem, or a key that stopped working.
        Clears on the next successful call.
        {fix && (
          <a
            href={fix.href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 flex items-center gap-1 font-medium underline underline-offset-2"
          >
            {fix.label}
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
};
