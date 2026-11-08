import { fileBadge } from "./file-kind";

export const FileTileBadge = ({ name }: { name: string }) => (
  <span className="bg-background/90 text-muted-foreground absolute bottom-2 left-2 rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">
    {fileBadge(name)}
  </span>
);
