import { Character, type CharacterProps } from "@/lib/components/character";

/**
 * The light-green page banner: a title and line, the page's main action at
 * the bottom right, and a character standing on the bottom edge.
 * `PageHeader` draws it on every top-level page.
 */
export const PageBanner = ({
  title,
  description,
  character,
  action,
}: {
  title: string;
  description?: string;
  character: CharacterProps["name"];
  action?: React.ReactNode;
}) => (
  <div className="bg-brand-wash border-brand/15 relative flex items-center gap-6 overflow-hidden rounded-lg border px-6 py-5">
    <div className="min-w-0 flex-1">
      <h1 className="text-xl font-medium tracking-tight">{title}</h1>
      {description && (
        <p className="text-muted-foreground mt-1 max-w-xl text-sm">
          {description}
        </p>
      )}
    </div>
    {/* Bottom-right, just left of the character. */}
    {action && <div className="shrink-0 self-end">{action}</div>}
    {/* Stands on the banner's bottom edge (the drawing's feet are ~12% up
        its box), and hides on narrow screens where the text needs the room. */}
    <Character
      name={character}
      size={76}
      className="-mb-[30px] mr-2 hidden self-end sm:block"
    />
  </div>
);
