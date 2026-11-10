import { Skeleton } from "@onecli/ui/components/skeleton";
import { cn } from "@onecli/ui/lib/utils";
import { NewAgentGlyph } from "./new-agent-glyph";
import { RailAgentSkeleton } from "./rail-agent-skeleton";
import { RailLogoMark } from "./rail-logo-mark";
import { ScopeHeaderSkeleton } from "./scope-header-skeleton";
import { SectionSkeleton } from "./section-skeleton";
import {
  RAIL_BUTTON,
  RAIL_BUTTON_IDLE,
  SHELL_BODY,
  SHELL_FRAME,
  SHELL_PAGE,
  SHELL_PAGE_SCROLL,
  SHELL_PANEL,
  SHELL_RAIL,
  SHELL_RAIL_LIST,
  SHELL_SIDEBAR,
  SHELL_TOP_BAR,
  SIDEBAR_ROW,
} from "./shell-geometry";

/**
 * The dashboard before it can draw itself: while sign-in resolves, the
 * session check runs and the first page is on its way. The frame is the
 * shell's own (the same classes, from `shell-geometry`), so the rail,
 * sidebar and panel sit exactly where the real ones will, and only their
 * contents fill in: the logo is the real mark, the New agent square its
 * resting look, the rest placeholders. `sidebar` and `body` are the parts
 * that depend on the page being opened (an agent's rows and its chat);
 * left out, page rows and page blocks stand in, and a `body` of `null`
 * leaves the panel empty for the page's own skeleton to fill (the home
 * page, which cannot know yet where it lands).
 *
 * Below `md` the rail and sidebar live in a sheet, as in the shell.
 */
export const DashboardShellSkeleton = ({
  sidebar,
  body,
}: {
  sidebar?: React.ReactNode;
  body?: React.ReactNode;
}) => (
  <div aria-busy="true" className={SHELL_FRAME}>
    <span className="sr-only">Loading</span>
    <div aria-hidden className="hidden shrink-0 md:flex">
      <div className={SHELL_RAIL}>
        <div className="mb-1 flex size-9 items-center justify-center">
          <RailLogoMark />
        </div>
        <div className={SHELL_RAIL_LIST}>
          <RailAgentSkeleton />
        </div>
        <div className={cn(RAIL_BUTTON, RAIL_BUTTON_IDLE, "opacity-50")}>
          <NewAgentGlyph />
        </div>
        <div className="flex-1" />
        <div className={RAIL_BUTTON}>
          <Skeleton className="size-[18px] rounded-md" />
        </div>
        <div className={RAIL_BUTTON}>
          <Skeleton className="size-8 rounded-full" />
        </div>
      </div>
      <div className={SHELL_SIDEBAR}>
        {sidebar ?? (
          <div className="flex flex-col gap-0.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn(SIDEBAR_ROW, "h-8")}>
                <Skeleton className="size-4 shrink-0" />
                <Skeleton className="h-3.5 w-24" />
              </div>
            ))}
          </div>
        )}
        <div className="mt-auto pt-4">
          <ScopeHeaderSkeleton />
        </div>
      </div>
    </div>
    <div className={SHELL_PANEL}>
      <div aria-hidden className={SHELL_TOP_BAR} />
      <div className={SHELL_BODY}>
        {body === undefined ? (
          <div className={SHELL_PAGE_SCROLL}>
            <div className={SHELL_PAGE}>
              <SectionSkeleton />
            </div>
          </div>
        ) : (
          body
        )}
      </div>
    </div>
  </div>
);
