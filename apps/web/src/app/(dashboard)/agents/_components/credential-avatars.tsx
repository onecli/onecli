"use client";

import { KeyRound, Plug } from "lucide-react";
import { getApp } from "@onecli/api/apps/registry";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import type { GrantsSummaryEntry } from "@/lib/api";
import { AppIcon } from "@/app/(dashboard)/connections/_components/app-icon";

// What an agent can reach, as an overlapping avatar stack. This replaces a row
// of full-text badges (`guy@chartdb.io`, `ronsm0987@gmail.com`, …) that ate the
// card's width and stopped scaling after about three credentials — a list is
// meant to be scannable down the names column, not across the chips.
//
// The stack is decorative: the labels live in the tooltips for pointer users
// and in one `sr-only` sentence for everyone else, so a card with six
// credentials adds six hover targets but ZERO tab stops.

const MAX_AVATARS = 5;
/** Names listed inside the "+N" tooltip before it summarizes the rest. */
const OVERFLOW_NAMED = 8;

const labelOf = (entry: GrantsSummaryEntry): string =>
  entry.kind === "app"
    ? (entry.label ?? getApp(entry.provider)?.name ?? entry.provider)
    : entry.name;

const keyOf = (entry: GrantsSummaryEntry): string =>
  entry.kind === "app"
    ? `app:${entry.connectionId}`
    : `${entry.kind}:${entry.id}`;

/** The glyph inside one avatar: the app's own logo when we know the provider,
 * otherwise a kind-appropriate icon (never a bare letter — a monogram beside
 * real product logos reads as a broken image). */
const Glyph = ({ entry }: { entry: GrantsSummaryEntry }) => {
  if (entry.kind !== "app") {
    return <KeyRound className="text-muted-foreground size-3.5" />;
  }
  const app = getApp(entry.provider);
  if (!app) return <Plug className="text-muted-foreground size-3.5" />;
  return (
    <AppIcon
      icon={app.icon}
      darkIcon={app.darkIcon}
      name={app.name}
      size={14}
    />
  );
};

interface CredentialAvatarsProps {
  entries: GrantsSummaryEntry[];
  /** The agent's full credential count — may exceed `entries.length`. */
  total: number;
}

export const CredentialAvatars = ({
  entries,
  total,
}: CredentialAvatarsProps) => {
  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_AVATARS);
  const hidden = entries.slice(MAX_AVATARS);
  // Count from `total` so the badge stays honest even if the API ever caps the
  // entry list below the real number.
  const extra = Math.max(total - shown.length, 0);

  const overflowLabel =
    hidden.length > 0
      ? [
          ...hidden.slice(0, OVERFLOW_NAMED).map(labelOf),
          ...(hidden.length > OVERFLOW_NAMED
            ? [`and ${String(hidden.length - OVERFLOW_NAMED)} more`]
            : []),
        ].join(", ")
      : `${String(extra)} more`;

  return (
    <>
      {/* `-space-x-1.5` overlaps the circles; the background-coloured ring is
          what keeps each one legible against its neighbour. */}
      <span className="flex -space-x-1.5" aria-hidden="true">
        {shown.map((entry) => (
          <Tooltip key={keyOf(entry)}>
            <TooltipTrigger asChild>
              <span className="ring-background bg-card flex size-6 items-center justify-center overflow-hidden rounded-full border ring-2">
                <Glyph entry={entry} />
              </span>
            </TooltipTrigger>
            <TooltipContent>{labelOf(entry)}</TooltipContent>
          </Tooltip>
        ))}
        {extra > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ring-background bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full border text-[10px] font-medium tabular-nums ring-2">
                +{extra}
              </span>
            </TooltipTrigger>
            <TooltipContent>{overflowLabel}</TooltipContent>
          </Tooltip>
        )}
      </span>
      <span className="sr-only">
        Can use {total} {total === 1 ? "credential" : "credentials"}:{" "}
        {entries.map(labelOf).join(", ")}
      </span>
    </>
  );
};
