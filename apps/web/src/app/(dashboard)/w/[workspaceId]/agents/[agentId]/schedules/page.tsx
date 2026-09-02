import type { Metadata } from "next";
import { SchedulesSection } from "./_components/schedules-section";

export const metadata: Metadata = {
  title: "Schedules",
};

export default function AgentSchedulesPage() {
  return <SchedulesSection />;
}
