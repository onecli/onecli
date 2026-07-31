"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@onecli/ui/components/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@onecli/ui/components/select";
import { useAgentsForProject } from "@/hooks/use-agents";
import { useProjectsList } from "@/hooks/use-projects";

interface GetStartedPickerProps {
  /** The org to pick a project from; null keeps the dialog closed. */
  organizationId: string | null;
  onOpenChange: (open: boolean) => void;
}

// The org/account-scope front door to the Install page: pick a project of
// THIS org (explicit header override, server-fenced against the caller's
// memberships), then an agent, then land on that project's Install page with
// the choice preselected. A router, not a content surface — the instructions
// live only on the page.
export const GetStartedPicker = ({
  organizationId,
  onOpenChange,
}: GetStartedPickerProps) => {
  const router = useRouter();
  const open = organizationId !== null;

  const [projectId, setProjectId] = useState<string>("");
  const [agentId, setAgentId] = useState<string>("");

  const { data: projects = [], isPending: projectsPending } = useProjectsList({
    organizationId: organizationId ?? undefined,
    enabled: open,
  });
  const { data: agents = [], isPending: agentsPending } =
    useAgentsForProject(projectId);

  // Reset on every open; a single visible project needs no choice.
  useEffect(() => {
    if (!open) {
      setProjectId("");
      setAgentId("");
    }
  }, [open]);
  useEffect(() => {
    const only = projects.length === 1 ? projects[0] : undefined;
    if (open && only) setProjectId(only.id);
  }, [open, projects]);
  useEffect(() => {
    setAgentId((current) =>
      current && agents.some((a) => a.id === current)
        ? current
        : ((agents.find((a) => a.isDefault) ?? agents[0])?.id ?? ""),
    );
  }, [agents]);

  const selectedAgent = agents.find((a) => a.id === agentId);

  const handleContinue = () => {
    if (!projectId || !selectedAgent) return;
    const query = selectedAgent.isDefault
      ? ""
      : `?agent=${encodeURIComponent(selectedAgent.identifier)}`;
    onOpenChange(false);
    router.push(`/p/${projectId}/install${query}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Get started</DialogTitle>
          <DialogDescription>
            Choose where you&apos;ll run your agent.
          </DialogDescription>
        </DialogHeader>

        {projectsPending ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        ) : projects.length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">
            You don&apos;t have access to any projects in this organization yet.{" "}
            <Link
              href={`/org/${organizationId}/projects`}
              className="text-foreground font-medium underline underline-offset-2"
              onClick={() => onOpenChange(false)}
            >
              Go to projects
            </Link>
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" id="gsp-project-label">
                Project
              </label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger
                  className="w-full"
                  aria-labelledby="gsp-project-label"
                >
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name ?? project.slug ?? project.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium" id="gsp-agent-label">
                Agent
              </label>
              <Select
                value={agentId}
                onValueChange={setAgentId}
                disabled={!projectId || agentsPending}
              >
                <SelectTrigger
                  className="w-full"
                  aria-labelledby="gsp-agent-label"
                >
                  <SelectValue
                    placeholder={
                      projectId ? "Select an agent" : "Pick a project first"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {agents.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
                      {agent.isDefault ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                Preselected to the project&apos;s default — most people just hit
                Continue.
              </p>
            </div>

            <Button
              variant="brand"
              onClick={handleContinue}
              disabled={!projectId || !selectedAgent}
            >
              Continue
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
