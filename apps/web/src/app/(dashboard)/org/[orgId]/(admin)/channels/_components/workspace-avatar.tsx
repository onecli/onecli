/**
 * A connected chat workspace's avatar. Its initials, not the provider logo:
 * the row already sits inside that provider's card, so repeating the mark
 * says nothing, while the initials tell you *which* workspace at a glance.
 */

/** Two letters, so a one-word workspace ("OneCLI") reads as "ON", not "O". */
export const workspaceInitials = (name: string) => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters =
    words.length === 1
      ? words[0]!.slice(0, 2)
      : words
          .slice(0, 2)
          .map((word) => word[0])
          .join("");
  return letters.toUpperCase();
};

export const WorkspaceAvatar = ({ name }: { name: string }) => (
  <span
    aria-hidden
    className="bg-card flex size-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold"
  >
    {workspaceInitials(name)}
  </span>
);
