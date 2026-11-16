import { BookOpen } from "lucide-react";
import { Button } from "@onecli/ui/components/button";

/** The public docs site; every in-app docs link hangs off it. */
export const DOCS_URL = "https://onecli.sh/docs";

/** The page that explains API keys: both scopes, the headers, the errors. */
export const API_KEYS_DOCS_URL = `${DOCS_URL}/api-reference#authentication`;

/**
 * A small outlined "Docs" button for a settings page header: the page's
 * reference on onecli.sh/docs, opened in a new tab. One shape everywhere,
 * so a reader learns it once.
 */
export const DocsLink = ({
  href,
  label = "Docs",
}: {
  href: string;
  /** Visible text; the accessible name says it opens the docs. */
  label?: string;
}) => (
  <Button variant="outline" size="sm" className="shrink-0" asChild>
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens in a new tab)`}
    >
      <BookOpen className="size-3.5" aria-hidden />
      {label}
    </a>
  </Button>
);
