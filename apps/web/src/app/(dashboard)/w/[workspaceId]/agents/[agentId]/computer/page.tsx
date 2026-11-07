import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DesktopTheaterPage } from "@/ee/desktop/desktop-theater-page";
import { IS_CLOUD } from "@/lib/env";

export const metadata: Metadata = {
  title: "Computer",
};

/**
 * The agent's hosted desktop, full page (pop-outs, deep links, phones).
 * Hosted platform only: on a self-host this page does not exist. Suspense
 * covers the takeover deep link.
 */
export default function AgentComputerPage() {
  if (!IS_CLOUD) notFound();
  return (
    <Suspense>
      <DesktopTheaterPage />
    </Suspense>
  );
}
