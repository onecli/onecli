"use client";

import { Maximize2, Minus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import type { DesktopState } from "./api";
import { useWakeDesktop } from "./use-desktop";
import { DesktopAskLine } from "./desktop-ask-line";
import { DesktopScreen } from "./desktop-screen";
import { QUALITY_CARD } from "./desktop-view";

/** Dark glass over the live picture: legible on any wallpaper, quiet
 * enough not to read as a second screen. Darker under the pointer. */
const GLASS =
  "bg-black/55 text-white backdrop-blur-md transition-[opacity,background-color] duration-150 motion-reduce:transition-none";
/** Shown on hover or keyboard focus with a mouse, always on touch. */
const REVEAL =
  "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";

export const DesktopDockCard = ({
  agentId,
  agentName,
  state,
  onExpand,
  onMinimize,
}: {
  agentId: string;
  agentName: string;
  state: DesktopState;
  onExpand: () => void;
  onMinimize: () => void;
}) => {
  const wake = useWakeDesktop(agentId);
  return (
    <figure className="group relative w-[280px]">
      <DesktopScreen
        state={state}
        viewOnly
        quality={QUALITY_CARD}
        className="rounded-[12px] shadow-[0_1px_2px_rgb(0_0_0/0.08),0_16px_36px_-14px_rgb(0_0_0/0.45)]"
      >
        <button
          type="button"
          onClick={onExpand}
          aria-label={`Open ${agentName}’s screen`}
          className="focus-visible:ring-ring absolute inset-0 flex items-center justify-center rounded-[12px] outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span
            className={`${GLASS} ${REVEAL} flex h-7 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-xs font-medium hover:bg-black/75`}
          >
            <Maximize2 className="size-3" aria-hidden />
            Open
          </span>
        </button>
        <button
          type="button"
          onClick={onMinimize}
          aria-label="Minimize the computer"
          className={`${GLASS} ${REVEAL} focus-visible:ring-ring absolute top-2 right-2 flex size-6 items-center justify-center rounded-full outline-none hover:bg-black/75 focus-visible:ring-2 after:absolute after:-inset-2.5 after:content-['']`}
        >
          <Minus className="size-3.5" aria-hidden />
        </button>
        {state.sandboxState === "asleep" && (
          <Button
            size="sm"
            loading={wake.isPending}
            className="absolute bottom-2.5 left-1/2 h-7 -translate-x-1/2 rounded-full px-3 text-xs pointer-coarse:h-11"
            onClick={() =>
              wake.mutate(undefined, {
                onError: () => toast.error("Couldn’t wake the computer."),
              })
            }
          >
            {wake.isPending ? "Waking…" : "Wake"}
          </Button>
        )}
        {state.request && (
          <div
            className={`${GLASS} pointer-events-none absolute top-2 right-10 left-2 rounded-md px-2 py-1`}
          >
            <DesktopAskLine reason={state.request.reason} className="text-xs" />
          </div>
        )}
      </DesktopScreen>
      {/* The card floats over the transcript, so the caption carries its
          own backdrop to stay legible over messages behind it. */}
      <figcaption className="mt-1.5 flex justify-center">
        <span className="bg-background/90 text-muted-foreground max-w-full truncate rounded-full px-2 py-0.5 text-xs backdrop-blur-sm">
          {agentName}’s screen
        </span>
      </figcaption>
    </figure>
  );
};
