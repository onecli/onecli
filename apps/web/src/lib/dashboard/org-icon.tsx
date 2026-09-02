const getOrgInitials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

export const OrgIcon = ({ name }: { name: string }) => (
  <div className="border-border bg-background text-foreground flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold">
    {getOrgInitials(name)}
  </div>
);
