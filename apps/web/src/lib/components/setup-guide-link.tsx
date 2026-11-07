import { ExternalLink } from "lucide-react";
import { IS_CLOUD } from "@/lib/env";

/**
 * Self-hosted users land straight on the page's self-hosted section: every
 * integration page on onecli.sh/docs marks it with `<a id="self-hosted">`.
 * Cloud opens the top of the page, where one-click connect is explained.
 */
export const guideHref = (url: string, isCloud: boolean = IS_CLOUD): string =>
  isCloud || url.includes("#") ? url : `${url}#self-hosted`;

export interface SetupGuideLinkProps {
  appName: string;
  /** `AppDefinition.setupGuideUrl`; renders nothing when the app has none. */
  url?: string;
}

/**
 * The one way a connect surface links an app's OneCLI setup guide
 * (`AppDefinition.setupGuideUrl`). Every place a user connects or configures
 * an app renders this same link, so every app reads the same:
 * "Follow the {app} setup guide ↗", opened in a new tab.
 */
export const SetupGuideLink = ({ appName, url }: SetupGuideLinkProps) => {
  if (!url) return null;
  return (
    <a
      href={guideHref(url)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-foreground underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:decoration-foreground"
    >
      Follow the {appName} setup guide
      <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );
};
