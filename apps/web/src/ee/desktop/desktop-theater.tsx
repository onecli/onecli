"use client";

import { MessageSquare } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import type { DesktopState } from "./api";
import { useWakeDesktop } from "./use-desktop";
import { toast } from "sonner";
import { DesktopAskLine } from "./desktop-ask-line";
import { DesktopControlPill } from "./desktop-control-pill";
import { DesktopScreen } from "./desktop-screen";
import { QUALITY_THEATER } from "./desktop-view";
import { isDriving, type DesktopSession } from "./use-desktop-session";

export interface DesktopTheaterProps {
  agentId: string;
  state: DesktopState;
  session: DesktopSession;
  /** The pill's chat segment, where the host has a chat column. */
  chat?: { open: boolean; onToggle: () => void };
  className?: string;
}

/**
 * The stage: the screen as large as the room allows, the agent's ask in one line above the bar when it has one,
 * and the control bar. The in-app overlay and the theater page both put
 * this on a dark ground, so the words are light.
 *
 * The screen's size container takes the remaining height after the ask
 * and the bar. CSS fits 16:10 to that room without guessing a footer
 * height or measuring in JS.
 */
export const DesktopTheater = ({
  agentId,
  state,
  session,
  chat,
  className,
}: DesktopTheaterProps) => {
  const wake = useWakeDesktop(agentId);
  const driving = isDriving(state);
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4",
        className,
      )}
    >
      <div className="flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]">
        <DesktopScreen
          state={state}
          viewOnly={!driving}
          quality={QUALITY_THEATER}
          onStatus={session.setStatus}
          onEscape={session.focusStop}
          viewRef={session.view}
          className="max-h-full w-full max-w-[calc(100cqh*1.6)] shrink-0 rounded-[10px] shadow-2xl ring-white/10"
        >
          {state.sandboxState === "asleep" && (
            <div className="absolute inset-x-0 bottom-5 flex justify-center">
              <Button
                size="sm"
                variant="secondary"
                className="min-h-11"
                loading={wake.isPending}
                onClick={() =>
                  wake.mutate(undefined, {
                    onError: () => toast.error("Couldn’t wake the computer."),
                  })
                }
              >
                {wake.isPending ? "Waking…" : "Wake"}
              </Button>
            </div>
          )}
        </DesktopScreen>
      </div>
      {state.request && !driving && (
        <DesktopAskLine
          reason={state.request.reason}
          className="pointer-events-auto"
        />
      )}
      {!state.available && chat && (
        <Button
          size="sm"
          variant="secondary"
          className="min-h-11 rounded-full"
          aria-pressed={chat.open}
          onClick={chat.onToggle}
        >
          <MessageSquare className="size-3.5" aria-hidden />
          Chat
        </Button>
      )}
      {state.available && (
        <DesktopControlPill
          state={state}
          status={session.status}
          taking={session.taking}
          stopping={session.stopping}
          onTake={session.onTake}
          onStop={session.onStop}
          stopRef={session.stopButton}
          chat={chat}
          onKeyboard={() => session.view.current?.openKeyboard()}
        />
      )}
    </div>
  );
};
