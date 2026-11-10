"use client";

import { Maximize2, Minus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import type { DesktopState } from "./api";
import { useWakeDesktop } from "./use-desktop";
import { DesktopAskLine } from "./desktop-ask-line";
import { DesktopScreen } from "./desktop-screen";
import { DesktopStatusDot, desktopStatusLabel } from "./desktop-status-dot";
import { QUALITY_CARD } from "./desktop-view";

/** The title bar's small icon buttons, with a touch-sized hit area. */
const BAR_BUTTON =
  "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] focus-visible:ring-ring relative flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 after:absolute after:-inset-1.5 after:content-[''] pointer-coarse:after:-inset-2.5";

/**
 * The agent's computer as a small window in a corner of the chat: a title
 * bar (its state, its name, expand and minimize) over the live screen.
 * The bar is also the handle the card is thrown by; a click on the screen
 * grows it to fill the chat.
 */
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
    <figure className="bg-card group w-[300px] overflow-hidden rounded-lg border shadow-[0_1px_2px_rgb(14_23_38/0.06),0_18px_40px_-16px_rgb(14_23_38/0.4)]">
      <figcaption className="flex h-8 cursor-grab items-center gap-2 border-b pr-1 pl-2.5">
        <DesktopStatusDot state={state} />
        {/* The agent is named everywhere around the card; the bar needs
            only what this window is. */}
        <span className="min-w-0 truncate text-xs font-medium">Computer</span>
        <span className="text-muted-foreground shrink-0 text-[11px]">
          {desktopStatusLabel(state)}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand to the full chat"
            title="Expand"
            className={BAR_BUTTON}
          >
            <Maximize2 className="size-3" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onMinimize}
            aria-label="Minimize the computer"
            title="Minimize"
            className={BAR_BUTTON}
          >
            <Minus className="size-3.5" aria-hidden />
          </button>
        </span>
      </figcaption>
      <DesktopScreen
        state={state}
        viewOnly
        quality={QUALITY_CARD}
        className="rounded-none ring-0"
      >
        <button
          type="button"
          onClick={onExpand}
          data-desktop-card-open
          aria-label={`Open ${agentName}’s screen`}
          className="focus-visible:ring-ring absolute inset-0 flex cursor-zoom-in items-end justify-center pb-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
        >
          {/* Asleep, the Wake button takes this spot. */}
          <span
            hidden={state.sandboxState === "asleep"}
            className="pointer-events-none flex h-7 items-center gap-1.5 rounded-full bg-black/60 pr-3 pl-2.5 text-xs font-medium text-white opacity-0 backdrop-blur-md transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100 [&[hidden]]:hidden"
          >
            <Maximize2 className="size-3" aria-hidden />
            Click to expand
          </span>
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
          <div className="pointer-events-none absolute inset-x-2 top-2 rounded-md bg-black/60 px-2 py-1 backdrop-blur-md">
            <DesktopAskLine reason={state.request.reason} className="text-xs" />
          </div>
        )}
      </DesktopScreen>
    </figure>
  );
};
