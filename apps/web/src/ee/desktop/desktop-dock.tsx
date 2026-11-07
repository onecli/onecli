"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import { useDesktop } from "./use-desktop";
import { agentComputerPath } from "@/lib/navigation";
import { DesktopDockCard } from "./desktop-dock-card";
import { registerDock } from "./dock-registry";
import { DesktopTheaterOverlay } from "./desktop-theater-overlay";
import { transitionDesktop } from "./desktop-transition";
import { useCardFits, useDesktopDockPrefs } from "./use-desktop-dock-prefs";
import { useThrowable, type DockCorner } from "./use-throwable";

/** Where each corner rests: inset from the chat's edges, clear of them. */
const CORNER_CLASS: Record<DockCorner, string> = {
  "top-left": "top-4 left-4 sm:left-6",
  "top-right": "top-4 right-4 sm:right-6",
  "bottom-left": "bottom-4 left-4 sm:left-6",
  "bottom-right": "bottom-4 right-4 sm:right-6",
};

export interface DesktopDockProps {
  agentId: string;
  agentName: string;
  /** A stable portal target holding the EXISTING chat, not a second chat mount. */
  theaterChatHost?: HTMLElement | null;
  openRef?: React.Ref<DesktopDockHandle>;
}
export interface DesktopDockHandle {
  expand: () => void;
}

/** The card and theater own mutually exclusive stream lifetimes. The card
 * rests in a corner of the chat and can be thrown to another (useThrowable);
 * the chat is the only place it may go. Minimized, nothing floats over the
 * chat: the agent header's Computer button is the way back, reached through
 * the dock registry while this dock is mounted. */
export const DesktopDock = ({
  agentId,
  agentName,
  theaterChatHost,
  openRef,
}: DesktopDockProps) => {
  const { data } = useDesktop(agentId);
  const { prefs, update } = useDesktopDockPrefs(agentId);
  const cardFits = useCardFits();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    // A resized desktop overlay must not trap a phone-sized viewport.
    // Minimize without navigating away or discarding the chat draft.
    if (cardFits === false) setExpanded(false);
  }, [cardFits]);
  const dock = useRef<HTMLDivElement>(null);
  const {
    ref: throwableRef,
    dragging,
    handlers: throwHandlers,
  } = useThrowable({
    area: dock,
    corner: prefs.corner,
    onCorner: (corner) => update({ corner }),
  });
  const opener = useRef<HTMLElement | null>(null);
  const theaterHref = agentComputerPath(pathname, agentId);
  const askId = data?.request?.id;
  const changeOpen = useCallback((open: boolean) => {
    transitionDesktop(() => setExpanded(open));
  }, []);
  const expand = useCallback(() => {
    if (cardFits === false) {
      // No room for the overlay: the full page, focused on the ask if any.
      window.location.assign(agentComputerPath(pathname, agentId, askId));
      return;
    }
    opener.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    changeOpen(true);
  }, [cardFits, pathname, agentId, askId, changeOpen]);
  useImperativeHandle(openRef, () => ({ expand }), [expand]);
  const restoreFocus = useCallback(() => {
    const target = opener.current?.isConnected
      ? opener.current
      : (dock.current?.querySelector("button") ??
        document.querySelector<HTMLElement>("[data-desktop-header-chip]"));
    target?.focus({ preventScroll: true });
  }, []);

  const ready = data !== undefined && cardFits !== null;
  const showCard = ready && prefs.mode === "card" && cardFits;
  const cardOnScreen = showCard && !expanded;
  const opensTheater = askId !== undefined || cardFits === false;
  const restore = useCallback(() => {
    update({ mode: "card" });
    // The header button leaves as the card arrives: focus follows it.
    requestAnimationFrame(() =>
      dock.current
        ?.querySelector<HTMLElement>("button")
        ?.focus({ preventScroll: true }),
    );
  }, [update]);
  const minimize = useCallback(
    (focusAfter: "header" | "composer" = "header") => {
      update({ mode: "chip" });
      // The minimize button leaves with the card: hand focus to the way
      // back (the header button), or, after Esc, straight back to typing.
      requestAnimationFrame(() => {
        const composer =
          focusAfter === "composer"
            ? theaterChatHost?.querySelector<HTMLElement>("textarea")
            : null;
        (
          composer ??
          document.querySelector<HTMLElement>("[data-desktop-header-chip]")
        )?.focus({ preventScroll: true });
      });
    },
    [update, theaterChatHost],
  );
  useEffect(() => {
    if (!cardOnScreen) return;
    // Esc tucks the card back into the header. Anything else that owns Esc
    // goes first: an open dialog or menu (Radix handles it in the capture
    // phase and marks it handled), or a half-typed message in the composer.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.isComposing) return;
      const target = event.target;
      if (
        (target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement) &&
        target.value !== ""
      )
        return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      minimize("composer");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cardOnScreen, minimize]);
  useEffect(() => {
    if (!ready) return;
    return registerDock(agentId, {
      cardShowing: cardOnScreen,
      show: opensTheater ? expand : restore,
    });
  }, [agentId, ready, cardOnScreen, opensTheater, expand, restore]);

  if (!data || cardFits === null) return null;
  return (
    <>
      <div
        ref={dock}
        style={{ display: expanded ? "none" : undefined }}
        className="pointer-events-none absolute inset-0 z-20"
      >
        {cardOnScreen && (
          <div
            ref={throwableRef}
            {...throwHandlers}
            className={cn(
              "pointer-events-auto absolute touch-none select-none",
              CORNER_CLASS[prefs.corner],
              dragging && "[&_*]:cursor-grabbing",
            )}
          >
            <DesktopDockCard
              agentId={agentId}
              agentName={agentName}
              state={data}
              onExpand={expand}
              onMinimize={() => minimize()}
            />
          </div>
        )}
      </div>
      <DesktopTheaterOverlay
        agentId={agentId}
        agentName={agentName}
        state={data}
        open={expanded}
        onOpenChange={changeOpen}
        onRestoreFocus={restoreFocus}
        onPopOut={() => {
          update({ mode: "chip" });
          setExpanded(false);
        }}
        theaterHref={theaterHref}
        chatHost={theaterChatHost}
      />
    </>
  );
};
