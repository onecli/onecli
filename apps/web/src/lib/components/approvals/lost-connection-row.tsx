"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@onecli/ui/components/button";
import { AppIcon } from "@/lib/components/app-icon";
import { channelProviderUi } from "@/lib/agents/channel-providers/registry";
import { agentSectionPath } from "@/lib/navigation";
import type { LostChannelConnectionItem } from "@/lib/api/channel-alerts";
import { dismissChannelAlert } from "@/hooks/use-channel-alerts";
import { RequestedAtLabel } from "./requested-at-label";

interface LostConnectionRowProps {
  item: LostChannelConnectionItem;
  /** Called when the Fix link navigates away (the bell closes). */
  onNavigate?: () => void;
}

/** One "lost connection" alert: names the agent, says what it can't do, and
 * opens the agent's Channels tab, where Re-attach lives. Acting on it clears
 * it from this browser's bell. */
export const LostConnectionRow = ({
  item,
  onNavigate,
}: LostConnectionRowProps) => {
  const pathname = usePathname();
  // An older web against a newer API may not know the provider: say so
  // generically rather than crash, the registry's version-skew posture.
  const provider = channelProviderUi(item.provider);
  const platform = provider?.name ?? "chat app";
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex items-center gap-2">
        {provider && (
          <span className="flex size-4 shrink-0 items-center justify-center">
            <AppIcon icon={provider.iconSrc} name={provider.name} size={16} />
          </span>
        )}
        <p className="min-w-0 truncate text-sm font-semibold">
          {item.agentName} lost its {platform} connection
        </p>
        <RequestedAtLabel createdAt={item.lostAt} className="ms-auto" />
      </div>
      <p className="text-muted-foreground text-xs">
        The app was uninstalled or its access revoked, so {item.agentName}{" "}
        can&apos;t read or answer in {platform} until it&apos;s re-attached.
      </p>
      <div className="mt-1 flex items-center justify-end">
        <Button size="xs" variant="outline" asChild>
          <Link
            href={agentSectionPath(pathname, item.agentId, "channels")}
            onClick={() => {
              dismissChannelAlert(item);
              onNavigate?.();
            }}
          >
            Fix in {platform}
          </Link>
        </Button>
      </div>
    </div>
  );
};
