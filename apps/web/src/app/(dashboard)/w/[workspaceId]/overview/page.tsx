import type { Metadata } from "next";
import { OverviewContent } from "./_components/overview-content";

export const metadata: Metadata = {
  title: "Overview",
};

export default function OverviewPage() {
  return <OverviewContent />;
}
