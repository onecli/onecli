interface SettingsSectionProps {
  title: string;
  /** Optional: omit when the card below already explains itself, so the
   *  same sentence never stacks twice. */
  description?: string;
  children: React.ReactNode;
}

/**
 * A titled group of cards on a settings page: the page's `PageHeader` is the
 * h1, each section an h2, so the page reads as an outline (and a screen
 * reader's heading list matches what the eye sees).
 */
export const SettingsSection = ({
  title,
  description,
  children,
}: SettingsSectionProps) => (
  <section className="flex flex-col gap-3">
    <div className="space-y-1">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && (
        <p className="text-muted-foreground text-sm text-pretty">
          {description}
        </p>
      )}
    </div>
    {children}
  </section>
);
