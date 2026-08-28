interface InstallStepProps {
  number: number;
  title: string;
  description?: string;
  last?: boolean;
  children: React.ReactNode;
}

export const InstallStep = ({
  number,
  title,
  description,
  last,
  children,
}: InstallStepProps) => (
  <li className="relative flex gap-4 pb-8 last:pb-6">
    {!last && (
      <span
        aria-hidden
        className="bg-border absolute top-8 left-3 h-[calc(100%-2.5rem)] w-px"
      />
    )}
    <span className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold">
      {number}
    </span>
    <div className="min-w-0 flex-1 pt-0.5">
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </div>
  </li>
);
