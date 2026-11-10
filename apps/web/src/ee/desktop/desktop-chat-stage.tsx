"use client";

import { useCallback, useEffect, useRef } from "react";
import { ExternalLink, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import type { DesktopState } from "./api";
import { DesktopStatusDot, desktopStatusLabel } from "./desktop-status-dot";
import { DesktopTheater } from "./desktop-theater";
import { isDriving, useDesktopSession } from "./use-desktop-session";

const POPOUT_FEATURES = "popup=yes,width=1280,height=860";

export interface DesktopChatStageProps {
  agentId: string;
  agentName: string;
  state: DesktopState;
  /** Back to the card (the minimize button, or Esc). */
  onClose: () => void;
  /** The computer moved to its own window: the card steps aside too. */
  onPopOut: () => void;
  theaterHref: string;
}

/**
 * The computer grown to fill the chat: the card's screen becomes this
 * one (the view transition morphs it across), over the conversation but
 * never over the composer under it, so the person keeps talking to the
 * agent while they watch it work. A light title row in the page's own
 * style, then the screen and its control bar on a dark stage, the ground
 * `DesktopTheater` is drawn for.
 */
export const DesktopChatStage = ({
  agentId,
  agentName,
  state,
  onClose,
  onPopOut,
  theaterHref,
}: DesktopChatStageProps) => {
  const session = useDesktopSession(agentId, agentName);
  const root = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  // Focus lands where the next press most likely goes: Take control when
  // the agent is asking for a person, otherwise the way back to the chat.
  // Never pulls focus from somewhere the person already went (a click into
  // the composer while the stage was still growing).
  useEffect(() => {
    const before = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const now = document.activeElement;
      // Unmoved, or dropped to the page (the header button that opened
      // the stage leaves once it is up).
      if (now !== before && now !== document.body && now !== null) return;
      const take = root.current?.querySelector<HTMLButtonElement>(
        "[data-desktop-take-control]:not(:disabled)",
      );
      (state.request && take ? take : closeButton.current)?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
    // Once, on open: later polls must never pull focus around.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Esc goes back to the chat. Anything else that owns Esc goes first: an
    // open dialog or menu, and the captured screen, where Esc moves to Stop
    // instead (DesktopView handles that) so typing never drops out of it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      const target = event.target;
      // The key's target, not the focus: the screen's own handler has
      // already moved focus to Stop by the time this listener runs.
      if (isDriving(state) && target instanceof HTMLCanvasElement) return;
      if (
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement) &&
        target.value !== ""
      )
        return;
      // Handled: the card's own Esc (minimize) must not also fire.
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, onClose]);

  const popOut = useCallback(() => {
    let popup: Window | null = null;
    try {
      popup = window.open(
        theaterHref,
        `onecli-desktop-${agentId}`,
        POPOUT_FEATURES,
      );
    } catch {
      /* Browser policy can throw instead of returning null. */
    }
    if (!popup) {
      toast.error(
        "Pop-up blocked. Allow pop-ups to open the computer in its own window.",
      );
      return;
    }
    popup.opener = null;
    onPopOut();
  }, [agentId, onPopOut, theaterHref]);

  return (
    <section
      ref={root}
      aria-label={`${agentName}’s computer`}
      className="bg-background pointer-events-auto absolute inset-0 flex flex-col gap-3 p-3 sm:px-6 sm:pt-4 sm:pb-3"
    >
      <header className="flex h-8 shrink-0 items-center gap-2.5">
        <DesktopStatusDot state={state} />
        <h2 className="truncate text-sm font-medium">{agentName}’s computer</h2>
        <span className="text-muted-foreground truncate text-xs">
          {desktopStatusLabel(state)}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={popOut}
            aria-label="Open in its own window"
            title="Open in its own window"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </Button>
          <Button
            ref={closeButton}
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            <Minimize2 className="size-3.5" aria-hidden />
            Back to chat
          </Button>
        </div>
      </header>
      {/* The dark stage: the screen as large as the chat allows, its
          control bar under it. */}
      <div className="@container flex min-h-0 flex-1 flex-col rounded-lg bg-[#0e1726] p-3 sm:p-5">
        <DesktopTheater agentId={agentId} state={state} session={session} />
      </div>
    </section>
  );
};
