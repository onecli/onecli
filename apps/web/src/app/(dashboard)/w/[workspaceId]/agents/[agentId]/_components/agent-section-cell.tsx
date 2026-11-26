import {
  isFullHeightAgentSection,
  isTheaterAgentSection,
} from "@/lib/agents/agent-sections";
import { SectionShell } from "./section-shell";

/**
 * Where an agent section's content sits: the theater fills the raw
 * viewport, Chat the raw full-height cell, and every other section scrolls
 * in its own shell. The one placement rule, so a section, its loading
 * skeleton and the dashboard's first-load skeleton all land in the same
 * place. `shell={false}` keeps a section's cell but drops its scroll shell
 * (a centred empty state).
 */
export const AgentSectionCell = ({
  section,
  shell = !isFullHeightAgentSection(section),
  children,
}: {
  section: string;
  shell?: boolean;
  children: React.ReactNode;
}) =>
  isTheaterAgentSection(section) ? (
    children
  ) : (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shell ? <SectionShell>{children}</SectionShell> : children}
    </div>
  );
