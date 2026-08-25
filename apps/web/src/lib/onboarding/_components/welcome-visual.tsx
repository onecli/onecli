"use client";

import Image from "next/image";
import { KeyRound, Check } from "lucide-react";
import { cn } from "@onecli/ui/lib/utils";

/** Persona tiles: each employee's agent in its own sandbox. Real (synthetic)
 * portraits, not initials — the picture should read as a team of people, per
 * the brand's "an agent for every employee" graphics. The faces are
 * model-generated people who do not exist. */
const PERSONAS = [
  {
    name: "maya",
    team: "engineering",
    avatar: "/onboarding/maya.jpg",
    delay: "0ms",
  },
  {
    name: "sam",
    team: "finance",
    avatar: "/onboarding/sam.jpg",
    delay: "120ms",
  },
  {
    name: "ana",
    team: "support",
    avatar: "/onboarding/ana.jpg",
    delay: "240ms",
  },
] as const;

/**
 * The mission as one picture instead of three paragraphs: a row of isolated
 * sandboxes (one per employee), and beneath them the gateway holding the
 * keys. Pure CSS/React, brand accent tokens only, works in both themes. Below
 * `sm` the tiles shed their filler rows and long captions so the picture
 * stays legible at phone widths.
 */
export const WelcomeVisual = ({ className }: { className?: string }) => (
  <div
    className={cn("w-full max-w-2xl select-none", className)}
    aria-hidden="true"
  >
    {/* The team's sandboxes */}
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {PERSONAS.map(({ name, team, avatar, delay }) => (
        <div
          key={name}
          style={{ animationDelay: delay }}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 fill-mode-both border-brand/40 bg-brand/5 rounded-xl border border-dashed p-1.5 sm:p-2"
        >
          {/* the dashed border IS the sandbox boundary */}
          <div className="bg-card rounded-lg border p-2.5 text-left shadow-xs sm:p-3">
            <div className="flex items-center gap-2.5">
              <Image
                src={avatar}
                alt=""
                width={32}
                height={32}
                priority
                className="ring-brand/30 size-8 shrink-0 rounded-full object-cover ring-1"
              />
              <div className="min-w-0 font-mono text-[11px] leading-tight">
                <div className="truncate font-medium">{name}</div>
                <div className="text-muted-foreground hidden truncate sm:block">
                  {team}
                </div>
              </div>
            </div>
            <div className="mt-2.5 hidden space-y-1.5 sm:block">
              <div className="bg-muted h-1.5 w-4/5 rounded-full" />
              <div className="bg-muted h-1.5 w-3/5 rounded-full" />
            </div>
            <div className="text-brand mt-2.5 flex items-center gap-1 font-mono text-[10px]">
              <Check className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                sandboxed<span className="hidden sm:inline"> · no keys</span>
              </span>
            </div>
          </div>
        </div>
      ))}
    </div>

    {/* Connectors down to the gateway, one from each sandbox's center — the
        gap must mirror the tile grid's so the columns (and centers) align. */}
    <div className="grid grid-cols-3 gap-2 sm:gap-3">
      {PERSONAS.map(({ name }) => (
        <div key={name} className="flex justify-center">
          <div className="from-brand/40 h-10 w-px bg-gradient-to-b to-transparent" />
        </div>
      ))}
    </div>

    {/* The gateway: where the keys actually live */}
    <div className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 fill-mode-both from-brand/15 to-brand/5 rounded-xl border bg-gradient-to-r px-4 py-3 [animation-delay:360ms]">
      <div className="flex items-center justify-center gap-2 font-mono text-xs">
        <KeyRound className="text-brand size-3.5 shrink-0" aria-hidden />
        <span className="font-medium whitespace-nowrap">onecli gateway</span>
        <span className="text-muted-foreground hidden truncate sm:inline">
          holds every key · approves every call
        </span>
      </div>
    </div>
  </div>
);
