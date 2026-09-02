"use client";

import { usePathname } from "next/navigation";
import { cn } from "@onecli/ui/lib/utils";
import { STEP_LABELS, STEP_SLUGS, stepSlugFromPathname } from "../steps";

/** Shared wizard frame: width container + progress dots. Lives in the layout
 * so it persists (and the dots animate) across step navigations. */
export const FlowChrome = ({ children }: { children: React.ReactNode }) => {
  const pathname = usePathname();

  const currentSlug = stepSlugFromPathname(pathname);
  const currentIndex = currentSlug ? STEP_SLUGS.indexOf(currentSlug) : -1;

  return (
    // my-auto centers the step between header and footer when it fits (the
    // footer's own mt-auto shares the free space, landing the content just
    // above true center) and collapses to normal flow when it overflows —
    // tall screens get a composed page, small ones still scroll. Horizontal
    // padding defers to the layout's own gutter below sm: phone widths need
    // every pixel for the three-tile mission visual.
    <div className="mx-auto my-auto flex w-full max-w-4xl flex-col items-center py-10 sm:px-6">
      {currentIndex >= 0 && (
        <nav aria-label="Onboarding progress" className="mb-10">
          <ol className="flex items-center gap-2">
            {STEP_SLUGS.map((slug, i) => (
              <li
                key={slug}
                aria-current={i === currentIndex ? "step" : undefined}
              >
                {/* The label lives in real (visually hidden) text — an
                    aria-label on a bare span has no role to attach to and
                    screen readers would read three empty list items. */}
                <span className="sr-only">{STEP_LABELS[slug]}</span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "block h-1.5 rounded-full transition-[width,background-color]",
                    i === currentIndex
                      ? "bg-brand w-6"
                      : i < currentIndex
                        ? "bg-brand/40 w-1.5"
                        : "bg-border w-1.5",
                  )}
                />
              </li>
            ))}
          </ol>
        </nav>
      )}
      {children}
    </div>
  );
};
