import type { Metadata } from "next";
import { PageHeader } from "@/app/(dashboard)/_components/page-header";
import { SkillsSection } from "./skills-section";

export const metadata: Metadata = {
  title: "Skills",
};

export default function OrgSkillsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Skills"
        description="Organization-wide instructions: every hosted agent in every workspace carries these."
      />
      <SkillsSection tier="organization" />
    </div>
  );
}
