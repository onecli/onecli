import type { Metadata } from "next";
import { Suspense } from "react";
import { FileRecord } from "./_components/file-record";

export const metadata: Metadata = {
  title: "File",
};

/**
 * One file an agent sent (send_file), at the WORKSPACE level: the link
 * arrives from outside the web (the Slack line for a file that could not be
 * uploaded into the thread), so the page stands on the dashboard's own
 * chrome and names the agent that sent it rather than living inside that
 * agent's frame. The record reads `?c=` (Suspense: useSearchParams) and
 * shows its own skeleton while the metadata resolves.
 */
export default function WorkspaceFilePage() {
  return (
    <Suspense>
      <FileRecord />
    </Suspense>
  );
}
