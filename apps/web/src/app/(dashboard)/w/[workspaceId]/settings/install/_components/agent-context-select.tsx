"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { withWorkspacePrefix } from "@/lib/navigation";

const NEW_AGENT = "__new";

// Structural on purpose: agent lists arrive from both the /v1 client (string
// dates) and the server-action seed (Date) — this select needs neither.
interface AgentOption {
  id: string;
  name: string;
}

interface AgentContextSelectProps {
  agents: AgentOption[];
  value: string;
  onChange: (agentId: string) => void;
}

export const AgentContextSelect = ({
  agents,
  value,
  onChange,
}: AgentContextSelectProps) => {
  const router = useRouter();
  const pathname = usePathname();

  // A workspace with no agents at all — the normal starting state now that
  // nothing is seeded: offer the create path instead of an empty select.
  if (agents.length === 0) {
    return (
      <Link
        href={withWorkspacePrefix(pathname, "/agents")}
        className="text-muted-foreground hover:text-foreground pt-1 text-xs underline underline-offset-2"
      >
        Create an agent
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-muted-foreground text-xs" id="install-agent-label">
        Agent
      </span>
      <Select
        value={value}
        onValueChange={(v) =>
          v === NEW_AGENT
            ? router.push(withWorkspacePrefix(pathname, "/agents"))
            : onChange(v)
        }
      >
        <SelectTrigger
          size="sm"
          className="dark:bg-transparent"
          aria-labelledby="install-agent-label"
        >
          <SelectValue placeholder="Select agent" />
        </SelectTrigger>
        <SelectContent align="end">
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              {agent.name}
            </SelectItem>
          ))}
          <SelectItem value={NEW_AGENT}>New agent…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
