"use client";

import { useRef, useState } from "react";
import { ExternalLink, Trash2, Upload } from "lucide-react";
import { AgentAvatar } from "@/lib/agents/_components/agent-avatar";
import { AppIcon } from "@/lib/components/app-icon";
import {
  providerAppIcon,
  providerLabel,
} from "@/lib/agents/channel-provider-ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import { useUpdateAgentImage } from "@/hooks/use-agents";

/**
 * The avatar's upload/replace/remove door (the agent page header) — the
 * hook-carrying wrapper around the pure `AgentAvatar` mark.
 */
export const AgentAvatarEditor = ({
  agent,
}: {
  agent: {
    id: string;
    name: string;
    imageUrl?: string | null;
    /** Attached channel presences. A channel carrying a provider-served
     * `settingsUrl` (opened where the app's PROFILE icon is set) gets a
     * deep-link menu item. */
    channels?: { provider: string; settingsUrl?: string | null }[];
  };
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const update = useUpdateAgentImage();
  const settingsChannel = agent.channels?.find((c) => c.settingsUrl);

  const frame = <AgentAvatar agent={agent} pending={update.isPending} />;

  const onFile = (file: File | undefined) => {
    // The crop runs inside the mutation, so isPending covers it end to end.
    if (file) update.mutate({ agentId: agent.id, file });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {agent.imageUrl || settingsChannel ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Change agent image"
              className="focus-visible:ring-ring cursor-pointer rounded-lg transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
              disabled={update.isPending}
            >
              {frame}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => inputRef.current?.click()}>
              <Upload className="size-4" />{" "}
              {agent.imageUrl ? "Replace image" : "Upload image"}
            </DropdownMenuItem>
            {settingsChannel?.settingsUrl && (
              // The provider shows an app's PROFILE mark (sidebar, search)
              // from its own settings page, not from per-message icons. The
              // item renders for any provider that serves that page.
              <DropdownMenuItem asChild>
                <a
                  href={settingsChannel.settingsUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {(() => {
                    const app = providerAppIcon(settingsChannel.provider);
                    return app ? (
                      <AppIcon
                        icon={app.icon}
                        darkIcon={app.darkIcon}
                        name={app.name}
                        size={16}
                      />
                    ) : (
                      <ExternalLink className="size-4" />
                    );
                  })()}{" "}
                  Set as {providerLabel(settingsChannel.provider)} app icon…
                </a>
              </DropdownMenuItem>
            )}
            {agent.imageUrl && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => update.mutate({ agentId: agent.id, file: null })}
              >
                <Trash2 className="size-4" /> Remove image
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          aria-label="Upload agent image"
          className="focus-visible:ring-ring cursor-pointer rounded-lg transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
          disabled={update.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {frame}
        </button>
      )}
    </>
  );
};
