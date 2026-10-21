"use client";

import { useCallback, useEffect, useRef } from "react";
import { ExternalLink, Minimize2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogStage,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import type { DesktopState } from "./api";
import { DesktopTheater } from "./desktop-theater";
import { useDesktopDockPrefs } from "./use-desktop-dock-prefs";
import { isDriving, useDesktopSession } from "./use-desktop-session";

export interface DesktopTheaterOverlayProps {
  agentId: string;
  agentName: string;
  state: DesktopState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestoreFocus?: () => void;
  onPopOut?: () => void;
  theaterHref: string;
  /** Move this existing portal target, never render another transcript/SSE owner. */
  chatHost?: HTMLElement | null;
}
const POPOUT_FEATURES = "popup=yes,width=1280,height=860";

export const DesktopTheaterOverlay = ({
  agentId,
  agentName,
  state,
  open,
  onOpenChange,
  onRestoreFocus,
  onPopOut,
  theaterHref,
  chatHost,
}: DesktopTheaterOverlayProps) => {
  const session = useDesktopSession(agentId, agentName);
  const { prefs, update } = useDesktopDockPrefs(agentId);
  const previousFocus = useRef<HTMLElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const popOutButton = useRef<HTMLButtonElement>(null);
  // Focus an ask once the connection enables Take control, but never steal
  // focus from somebody who has already moved to Chat or another control.
  useEffect(() => {
    if (
      open &&
      state.request &&
      session.status === "connected" &&
      document.activeElement === popOutButton.current
    ) {
      stage.current
        ?.querySelector<HTMLButtonElement>(
          "[data-desktop-take-control]:not(:disabled)",
        )
        ?.focus();
    }
  }, [open, state.request, session.status]);
  const chatOpen = Boolean(chatHost) && prefs.chat && open;

  const attachChat = useCallback(
    (slot: HTMLElement | null) => {
      if (!chatHost || !slot) return;
      const parent = chatHost.parentNode;
      const next = chatHost.nextSibling;
      slot.appendChild(chatHost);
      return () => {
        if (parent)
          parent.insertBefore(
            chatHost,
            next?.parentNode === parent ? next : null,
          );
        else chatHost.remove();
      };
    },
    [chatHost],
  );

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
    if (onPopOut) onPopOut();
    else onOpenChange(false);
  }, [agentId, onOpenChange, onPopOut, theaterHref]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogStage
        ref={stage}
        aria-modal="true"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          previousFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          const take = stage.current?.querySelector<HTMLButtonElement>(
            "[data-desktop-take-control]:not(:disabled)",
          );
          if (state.request && take) {
            event.preventDefault();
            take.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (onRestoreFocus) onRestoreFocus();
          else if (previousFocus.current?.isConnected)
            previousFocus.current.focus({ preventScroll: true });
        }}
        onEscapeKeyDown={(event) => {
          // Esc on the captured canvas means "let me out of the screen",
          // not "close the theater". This document-level listener runs
          // first; the view's own Esc handler then moves focus to Stop.
          if (
            isDriving(state) &&
            document.activeElement?.tagName === "CANVAS"
          ) {
            event.preventDefault();
          }
        }}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
        className="gap-6 p-6 sm:p-8"
      >
        <DialogTitle className="sr-only">{agentName}’s computer</DialogTitle>
        {/* Radix retains its shell during exit animation. Unmount the stream
            immediately, BEFORE the dock can mount its watcher again. */}
        {open && (
          <>
            <div className="@container pointer-events-none relative flex min-h-0 min-w-0 flex-1 flex-col [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_textarea]:pointer-events-auto [&_canvas]:pointer-events-auto">
              <div className="pointer-events-auto absolute top-0 right-0 z-10 flex gap-1">
                <Button
                  ref={popOutButton}
                  size="icon"
                  variant="ghost"
                  className="size-11 text-white/80 hover:bg-white/10 hover:text-white"
                  onClick={popOut}
                  aria-label="Open in its own window"
                >
                  <ExternalLink className="size-4" aria-hidden />
                </Button>
                <DialogClose asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-11 text-white/80 hover:bg-white/10 hover:text-white"
                    aria-label="Back to the chat"
                  >
                    <Minimize2 className="size-4" aria-hidden />
                  </Button>
                </DialogClose>
              </div>
              <DesktopTheater
                agentId={agentId}
                state={state}
                session={session}
                chat={
                  chatHost
                    ? {
                        open: chatOpen,
                        onToggle: () => update({ chat: !prefs.chat }),
                      }
                    : undefined
                }
                className="pt-12"
              />
            </div>
            {/* Move before Radix hides outside content, even with Chat off.
                Moving only on toggle would carry stale aria-hidden markers
                from the original chat tree into the dialog. */}
            {chatHost && (
              <aside
                ref={attachChat}
                hidden={!chatOpen}
                aria-label={`Chat with ${agentName}`}
                className="bg-background text-foreground animate-in slide-in-from-right-4 fade-in-0 flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl shadow-2xl duration-200 motion-reduce:animate-none [&[hidden]]:hidden"
              />
            )}
          </>
        )}
      </DialogStage>
    </Dialog>
  );
};
