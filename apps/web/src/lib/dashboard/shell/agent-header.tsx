"use client";

import {
  startTransition,
  useEffect,
  useOptimistic,
  useRef,
  useState,
} from "react";
import { Camera, Pencil } from "lucide-react";
import { AgentAvatarEditor } from "@/lib/agents/_components/agent-avatar-editor";
import { useRenameAgent } from "@/hooks/use-agents";
import { AgentSquare } from "./agent-square-mark";
import { SIDEBAR_AGENT_HEADER } from "./shell-geometry";
import { AppIcon } from "@/lib/components/app-icon";
import { connectedPresences } from "@/lib/agents/channel-providers";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import type { Agent } from "@/lib/api/types";

/**
 * Where else this agent is reachable: the provider's real mark (Slack today)
 * right after the name, once it is connected there. The old sidebar showed
 * the same mark on the agent's row. The picture is decorative (a hover title
 * names it); it sits inside the Rename button, whose aria-label overrides
 * its contents, so the button's label carries it for screen readers
 * (`connectedNames`).
 */
const connectedUis = (channels: Agent["channels"]) =>
  connectedPresences(channels)
    .map((presence) => channelProviderUi(presence.provider))
    .filter((ui) => ui !== null);

const connectedNames = (channels: Agent["channels"]) => {
  const names = connectedUis(channels).map((ui) => ui.name);
  return names.length > 0 ? `, connected to ${names.join(", ")}` : "";
};

const ConnectedMarks = ({ channels }: { channels: Agent["channels"] }) => (
  <>
    {connectedUis(channels).map((ui) => (
      <span
        key={ui.id}
        aria-hidden
        title={`Connected to ${ui.name}`}
        className="flex shrink-0 items-center"
      >
        <AppIcon icon={ui.iconSrc} name={ui.name} size={14} />
      </span>
    ))}
  </>
);

/**
 * The sidebar's agent header: the photo (click to upload, replace or
 * remove) and the name, edited in place. Click the name, type, Enter or
 * blur saves; Escape puts the old name back. An unchanged or empty name
 * saves nothing. The new name shows the moment it is saved and stays while
 * the request runs; a failed save puts the old one back (with the
 * mutation's toast).
 */
export const AgentHeader = ({
  agent,
}: {
  agent: Pick<Agent, "id" | "name" | "imageUrl" | "channels">;
}) => {
  const rename = useRenameAgent();
  const [name, setOptimisticName] = useOptimistic(agent.name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (!next || next === name) {
      setDraft(name);
      return;
    }
    // The optimistic name holds until the request settles: the mutation's
    // own invalidation refetches the agent, which then carries it for real.
    startTransition(async () => {
      setOptimisticName(next);
      await rename
        .mutateAsync({ agentId: agent.id, name: next })
        .catch(() => {});
    });
  };

  return (
    <div className={SIDEBAR_AGENT_HEADER}>
      <AgentAvatarEditor
        agent={agent}
        className="group/avatar"
        renderFrame={(pending) => (
          <span className="relative block">
            <AgentSquare
              agent={agent}
              pending={pending}
              className="rounded-lg"
            />
            {/* Says the photo is editable: a camera on hover and focus. */}
            <span
              aria-hidden
              className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/45 text-white group-hover/avatar:flex group-focus-visible/avatar:flex"
            >
              <Camera className="size-4" />
            </span>
          </span>
        )}
      />
      {editing ? (
        <input
          ref={inputRef}
          aria-label="Agent name"
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(name);
              setEditing(false);
            }
          }}
          className="border-brand/40 bg-background focus-visible:ring-ring h-7 min-w-0 flex-1 rounded-md border px-1.5 text-base font-semibold outline-none focus-visible:ring-2"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={rename.isPending}
          aria-label={`Rename ${name}${connectedNames(agent.channels)}`}
          title="Rename"
          className="group hover:bg-foreground/[0.05] focus-visible:ring-ring flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-base font-semibold tracking-tight outline-none focus-visible:ring-2"
        >
          <span className="truncate">{name}</span>
          <ConnectedMarks channels={agent.channels} />
          <Pencil
            className="text-muted-foreground size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden
          />
        </button>
      )}
    </div>
  );
};
