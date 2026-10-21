import { EyeOff } from "lucide-react";

/** The agent read a channel message and chose not to answer: nothing was
 *  posted there. Quiet on purpose - it is a non-event, not an error. */
export const StayedSilentNote = () => (
  <p className="text-muted-foreground flex items-center gap-1.5 px-1 text-xs">
    <EyeOff className="size-3.5" aria-hidden />
    Read it and stayed silent. Nothing was posted in the channel.
  </p>
);
