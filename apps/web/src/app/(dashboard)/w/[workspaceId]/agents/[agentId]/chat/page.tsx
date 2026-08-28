import type { Metadata } from "next";
import { Suspense } from "react";
import { AttachParamDialog } from "./_components/attach-param-dialog";
import { DirectThreadSection } from "./_components/direct-thread-section";

export const metadata: Metadata = {
  title: "Chat",
};

/** The agent's Chat section (§3.18): the one direct thread. It owns the
 *  page's full height — the frame hands it the raw cell (no section shell)
 *  because the section table marks it `fullHeight`. */
export default function AgentChatPage() {
  return (
    <>
      <DirectThreadSection />
      {/* `?attach=<provider>` deep links (the Slack card's Attach button)
          open the attach dialog over the chat. Suspense: useSearchParams. */}
      <Suspense>
        <AttachParamDialog />
      </Suspense>
    </>
  );
}
