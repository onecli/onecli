import type { Metadata } from "next";
import { PageHeader } from "@dashboard/page-header";
import { TelemetryToggle } from "./_components/telemetry-toggle";

export const metadata: Metadata = {
  title: "General",
};

export default function GeneralSettingsPage() {
  return (
    <div className="flex flex-1 flex-col gap-4 max-w-5xl">
      <PageHeader title="General" description="Instance-wide preferences." />
      <TelemetryToggle />
    </div>
  );
}
