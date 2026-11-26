export interface LibraryRefProps {
  repo: string;
  branch: string;
}

/** A library source in one line: the repo, then its branch. */
export const LibraryRef = ({ repo, branch }: LibraryRefProps) => (
  <span className="min-w-0 truncate font-mono text-xs">
    {repo}
    <span className="text-muted-foreground"> · {branch}</span>
  </span>
);
