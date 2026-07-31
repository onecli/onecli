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
import { withProjectPrefix } from "@/lib/navigation";

const NEW_AGENT = "__new";

// Structural on purpose: agent lists arrive from both the /v1 client (string
// dates) and the server-action seed (Date) — this select needs neither.
interface AgentOption {
  id: string;
  name: string;
  isDefault: boolean;
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

  // A project with no agents at all (the default is normally seeded and
  // undeletable, so this is a rare edge): offer the create path instead of an
  // empty select.
  if (agents.length === 0) {
    return (
      <Link
        href={withProjectPrefix(pathname, "/agents")}
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
            ? router.push(withProjectPrefix(pathname, "/agents"))
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
              {agent.isDefault ? " (default)" : ""}
            </SelectItem>
          ))}
          <SelectItem value={NEW_AGENT}>New agent…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
