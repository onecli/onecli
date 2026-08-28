import { cn } from "@onecli/ui/lib/utils";

/**
 * The scroll container every NON-chat agent section brings for itself: the
 * page frame hands sections the raw full-height cell (the Chat section needs
 * it), so ordinary sections re-create the familiar padded, width-bounded
 * scrolling pane here. Server-component-safe — plain markup, no hooks.
 */
export const SectionShell = ({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) => (
  <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
    <div className={cn("mx-auto w-full max-w-4xl p-4 sm:p-6", className)}>
      {children}
    </div>
  </div>
);
