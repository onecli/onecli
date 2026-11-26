/** One labelled block of the run detail panel. */
export const RunSection = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <section className="space-y-1.5">
    <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
    {children}
  </section>
);
