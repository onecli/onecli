"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, X } from "lucide-react";
import { Dialog, DialogStage, DialogTitle } from "@onecli/ui/components/dialog";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { SettingsModalProvider } from "./modal-context";
import { MobilePagePicker } from "./mobile-page-picker";
import {
  clearSettingsCarryOver,
  isSettingsCarryOver,
} from "./use-switch-workspace";
import { WorkspacePicker } from "./workspace-picker";
import {
  SETTINGS_SECTIONS,
  settingsPage,
  visibleSettingsPages,
  withSettingsParam,
  type SettingsPageId,
  type SettingsViewer,
} from "./pages";

/**
 * The Settings modal's frame (the mock in plans/mocks/flatten-ui.html): a
 * dark scrim, one rounded card, a nav column on the left and the page on
 * the right. The page itself is a server component rendered by the
 * `@settings` slot and handed in as `children`; this frame only draws the
 * chrome and moves between pages by rewriting `?settings=`.
 *
 * Open state IS the URL. Closing removes the param and nothing else, so the
 * page under the modal keeps every other param it had (an agent chat's
 * `?draft=`), and Back after a deep link leaves the modal the way the
 * browser expects.
 *
 * It answers on the click, not on the server: closing hides the frame at
 * once and lets the URL catch up behind it, and a nav click marks its row
 * at once and dims the page until the new one lands. Moving between pages
 * replaces the history entry, so Back leaves Settings instead of walking
 * back through every page visited inside it.
 */

interface SettingsModalProps {
  page: SettingsPageId;
  viewer: SettingsViewer;
  /** The org the slot resolved; the pages inside act on it. */
  organizationId: string;
  /** The workspace in the URL, if any; the picker switches between them. */
  workspaceId?: string;
  workspaces: { id: string; name: string | null }[];
  children: React.ReactNode;
}

/** The Settings modal's frame plays its fade on every open and close, and a
 *  close keeps the frame on screen this long so the fade-out finishes before
 *  the URL drops `?settings=` and the slot unmounts it. Matches the card's
 *  `duration-150`. */
const CLOSE_FADE_MS = 150;

export const SettingsModal = ({
  page,
  viewer,
  organizationId,
  workspaceId,
  workspaces,
  children,
}: SettingsModalProps) => {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const pages = visibleSettingsPages(viewer);
  const [closing, setClosing] = React.useState(false);
  const [navigating, startNavigation] = React.useTransition();
  // The row the person just picked, shown active before the server answers.
  const [optimisticPage, setOptimisticPage] = React.useOptimistic(page);
  const current = settingsPage(optimisticPage);

  const hrefFor = (id: SettingsPageId | null) =>
    withSettingsParam(pathname, search, id);
  // Closing answers on the click: the frame starts its fade-out at once, and
  // the URL drops `?settings=` once the fade has played, so the slot unmounts
  // a frame that is already gone instead of cutting it off mid-fade. Every
  // way out (the scrim, Escape, X, Back to app) comes through here.
  const closeTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(closeTimer.current), []);
  const close = () => {
    // A ref, not `closing`: two ways out in the same tick (a scrim press and
    // Escape) both read the state before it updates.
    if (closeTimer.current !== undefined) return;
    setClosing(true);
    const href = hrefFor(null);
    closeTimer.current = setTimeout(
      () => router.push(href, { scroll: false }),
      CLOSE_FADE_MS,
    );
  };
  const goTo = (id: SettingsPageId) => {
    if (id === page) return;
    startNavigation(() => {
      setOptimisticPage(id);
      router.replace(hrefFor(id), { scroll: false });
    });
  };
  const bodyRef = React.useRef<HTMLDivElement>(null);
  // A workspace switch from the picker remounts the modal over the new
  // workspace: it was on screen a moment ago, so it reappears in place.
  // Every other mount (an open from anywhere, a reopen right after a close)
  // fades in.
  const [carriedOver] = React.useState(isSettingsCarryOver);
  React.useEffect(clearSettingsCarryOver, []);
  const frame = React.useMemo(
    () => ({ page, organizationId, workspaceId }),
    [page, organizationId, workspaceId],
  );

  return (
    <SettingsModalProvider value={frame}>
      <Dialog open={!closing} onOpenChange={(open) => !open && close()}>
        <DialogStage
          data-slot="settings-modal"
          aria-describedby={undefined}
          overlayClassName={cn(
            // `fill-mode-forwards`: a finished fade-out holds at 0 until the
            // slot unmounts. Radix keeps the end frame only until a 0ms timer
            // after `animationend`, and the URL drops `?settings=` after
            // CLOSE_FADE_MS, so one frame in between could paint the scrim
            // and the stage back at full opacity.
            "fill-mode-forwards bg-[#0e1726]/35 backdrop-blur-[2px] duration-150",
            carriedOver && !closing && "animate-none",
          )}
          className={cn(
            "fill-mode-forwards items-center justify-center duration-150",
            carriedOver && !closing && "animate-none",
          )}
          // Focus lands on the page, not on the Back button: the first thing
          // a keyboard user hears is the page title.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            bodyRef.current?.focus();
          }}
          // The stage fills the screen to centre the card, so a click on the
          // scrim lands on the stage, not on the overlay under it, and Radix
          // never reads it as outside. The card is the stage's only child:
          // a press on the stage itself is the scrim.
          onPointerDown={(e) => {
            if (e.target === e.currentTarget && e.button === 0) close();
          }}
        >
          <div
            data-slot="settings-modal-card"
            data-state={closing ? "closed" : "open"}
            className={cn(
              "bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:zoom-in-[0.98] data-[state=closed]:zoom-out-[0.98] flex h-full w-full overflow-hidden duration-150 ease-out motion-reduce:animate-none md:h-[88vh] md:w-[90vw] md:max-w-7xl md:rounded-xl md:border md:shadow-xl",
              carriedOver && !closing && "animate-none",
            )}
          >
            <DialogTitle className="sr-only">
              Settings: {current.title}
            </DialogTitle>
            <aside className="bg-canvas hidden w-56 shrink-0 flex-col overflow-y-auto border-r px-3 py-4 md:flex">
              <Button
                variant="ghost"
                size="sm"
                className="text-foreground hover:bg-foreground/[0.05] justify-start gap-2 px-2 font-medium"
                onClick={close}
              >
                <ArrowLeft className="size-4" aria-hidden />
                Back to app
              </Button>
              {/* Its own block: a divider and room under it, so the way out
                  never reads as the first section's heading. */}
              <div className="border-border mt-3 mb-5 border-t" />
              <nav aria-label="Settings" className="flex flex-col gap-6">
                {SETTINGS_SECTIONS.map((section) => {
                  const items = pages.filter((p) => p.section === section);
                  if (items.length === 0) return null;
                  return (
                    <div key={section}>
                      <p className="text-foreground px-2 pb-1.5 text-xs font-semibold tracking-wide uppercase">
                        {section}
                      </p>
                      <ul className="space-y-0.5">
                        {items.map((item) => {
                          const active = item.id === optimisticPage;
                          return (
                            <li key={item.id}>
                              <Link
                                href={hrefFor(item.id)}
                                scroll={false}
                                aria-current={active ? "page" : undefined}
                                onNavigate={(e) => {
                                  e.preventDefault();
                                  goTo(item.id);
                                }}
                                className={cn(
                                  "flex h-8 items-center rounded-md px-2 text-sm transition-colors",
                                  active
                                    ? "bg-brand-wash text-brand-ink font-medium"
                                    : "text-foreground/80 hover:bg-foreground/[0.05] hover:text-foreground",
                                )}
                              >
                                <span className="truncate">{item.title}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </nav>
            </aside>
            <div className="relative flex min-w-0 flex-1 flex-col">
              {/* A top bar of its own on wide screens, ABOVE the page
                  instead of floating over its banner. The picker sits in the
                  page's own column (the body's max-w-4xl and padding, and
                  the same scrollbar gutter), so its right edge lines up with
                  the banner's below it. The close button stays in the
                  corner, and the row keeps clear of it: its right margin is
                  the centred column's own, or 24px when that is less (the
                  X is 32px at a 16px inset, so the picker always ends 8px
                  before it). That only bites on a narrow modal (a tablet),
                  where the centred row ran 16px under the X. */}
              <div className="relative hidden h-14 shrink-0 overflow-y-hidden [scrollbar-gutter:stable] md:block">
                <div
                  data-slot="settings-modal-topbar"
                  className="mr-[max(1.5rem,calc((100%_-_56rem)_/_2))] ml-auto flex h-full max-w-4xl items-center justify-end px-4 sm:px-8"
                >
                  {workspaceId && workspaces.length > 1 && (
                    <WorkspacePicker
                      page={page}
                      workspaceId={workspaceId}
                      workspaces={workspaces}
                    />
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close settings"
                  className="text-muted-foreground hover:text-foreground absolute top-1/2 right-4 -translate-y-1/2"
                  onClick={close}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </div>
              <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 md:hidden">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-2 px-2"
                  onClick={close}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  Back
                </Button>
                <MobilePagePicker
                  page={optimisticPage}
                  viewer={viewer}
                  onPick={goTo}
                />
              </div>
              <div
                ref={bodyRef}
                tabIndex={-1}
                aria-busy={navigating}
                className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable]"
              >
                {/* The hosted page keeps its own `PageHeader`; the modal
                    renders it, so no second title is drawn here. While the
                    next page is on its way the current one dims, so the
                    click reads as taken. The `settings-modal-body` hook
                    lets a page tighten its own layout inside the modal. */}
                <main
                  data-slot="settings-modal-body"
                  className={cn(
                    "mx-auto min-w-0 max-w-4xl p-4 transition-opacity duration-150 sm:px-8 sm:py-7 md:pt-0",
                    navigating && "opacity-60",
                  )}
                >
                  {children}
                </main>
              </div>
            </div>
          </div>
        </DialogStage>
      </Dialog>
    </SettingsModalProvider>
  );
};
