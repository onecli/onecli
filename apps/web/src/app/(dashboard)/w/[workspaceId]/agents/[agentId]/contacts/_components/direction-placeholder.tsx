"use client";

export interface DirectionPlaceholderProps {
  /** The quiet word the cell shows. */
  label: string;
  /** The full sentence a screen reader hears in its place. */
  description: string;
}

/** A half with no record yet: nothing to change, so plain text, never a
 *  menu, and never a setting the server does not hold. */
export const DirectionPlaceholder = ({
  label,
  description,
}: DirectionPlaceholderProps) => (
  <span className="text-muted-foreground px-2 text-xs">
    <span aria-hidden>{label}</span>
    <span className="sr-only">{description}</span>
  </span>
);
