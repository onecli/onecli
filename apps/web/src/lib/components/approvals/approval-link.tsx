"use client";

import { ExternalLink } from "lucide-react";

/** Only an absolute `https:` URL may become a link. The gateway builds record
 *  links itself (the connection's own host), but a card renders data from the
 *  approvals API, so the scheme is enforced here too: `javascript:` or
 *  `data:` can never reach an `href`. */
export const safeHttpsUrl = (raw: string | undefined): string | null => {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
};

/** A record named on an approval card: a new-tab link to its page when it
 *  has a safe one, else its plain text. Plain inline (not inline-flex), so a
 *  `truncate` title still ellipsizes a long record name. */
export const ApprovalLink = ({
  href,
  children,
}: {
  href: string | undefined;
  children: React.ReactNode;
}) => {
  const safe = safeHttpsUrl(href);
  if (!safe) return <>{children}</>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className="text-foreground focus-visible:ring-ring decoration-muted-foreground/50 hover:decoration-foreground rounded-sm underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
      <ExternalLink
        aria-hidden="true"
        className="ms-1 inline size-3 align-[-0.125em]"
      />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
};
