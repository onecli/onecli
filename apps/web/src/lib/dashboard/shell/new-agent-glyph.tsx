import { Plus } from "lucide-react";

/** The New agent square's mark: a dashed ring with a plus. */
export const NewAgentGlyph = () => (
  <span className="border-muted-foreground/40 flex size-7 items-center justify-center rounded-full border border-dashed">
    <Plus className="size-3.5" aria-hidden />
  </span>
);
