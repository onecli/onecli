/**
 * One block of a merged agent page (Knowledge, Agent settings): a titled
 * section anchored by its old section name, so the old URL
 * (`/models` -> `/settings#models`) lands on it. `scroll-mt` clears the top
 * bar when a `#<id>` link lands here.
 */
export const PageBlock = ({
  id,
  title,
  blurb,
  children,
}: {
  id: string;
  title: string;
  /** One line under the title, saying what the block holds. */
  blurb?: string;
  children: React.ReactNode;
}) => (
  <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-6">
    <div className="mb-4">
      <h2 id={`${id}-heading`} className="text-base font-semibold">
        {title}
      </h2>
      {blurb && <p className="text-muted-foreground text-sm">{blurb}</p>}
    </div>
    {children}
  </section>
);
