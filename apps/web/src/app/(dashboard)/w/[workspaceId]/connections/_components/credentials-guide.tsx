"use client";

import { SetupGuideLink } from "@/lib/components/setup-guide-link";
import {
  GOOGLE_ENABLE_APIS_URL,
  groupOf,
  vendorSetupGuideFor,
} from "@onecli/api/apps/oauth/groups";

export interface CredentialsGuideProps {
  provider: string;
  appName: string;
  /** The app's own OneCLI setup guide (`AppDefinition.setupGuideUrl`). */
  setupGuideUrl?: string;
}

/**
 * The one setup-guide link of a Custom credentials surface. An app that
 * shares a vendor client links the vendor's guide instead of its own: one
 * Google client serves every Google app, so it is set up once from the Google
 * guide. Google also gets the one-click link that enables its APIs in the
 * admin's Cloud project.
 */
export const CredentialsGuide = ({
  provider,
  appName,
  setupGuideUrl,
}: CredentialsGuideProps) => {
  const vendorGuide = vendorSetupGuideFor(provider);
  const url = vendorGuide?.url ?? setupGuideUrl;
  const isGoogle = groupOf(provider) === "google";
  if (!url && !isGoogle) return null;

  return (
    <div className="grid justify-items-start gap-1.5">
      <SetupGuideLink appName={vendorGuide?.name ?? appName} url={url} />
      {isGoogle && (
        <a
          href={GOOGLE_ENABLE_APIS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Enable the Google APIs in your Cloud project
        </a>
      )}
    </div>
  );
};
