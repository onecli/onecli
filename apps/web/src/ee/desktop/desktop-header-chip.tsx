"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Monitor } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { cn } from "@onecli/ui/lib/utils";
import { agentComputerPath, matchAgentPage } from "@/lib/navigation";
import { useMountedDock } from "./dock-registry";
import { useDesktop } from "./use-desktop";

/** Up to this many characters, the button names the agent ("Donna's
 * Computer"); a longer name would crowd the header, so it reads "Computer".
 * On a phone it always reads "Computer": the title beside it already names
 * the agent, and the name would squeeze that title to a few letters. The
 * accessible name always names the agent. */
const MAX_NAME_IN_LABEL = 6;

/**
 * The agent header's Computer button, beside the agent's menu: the one way
 * back to a minimized computer, so nothing floats over the chat. It owns no
 * stream. Quiet like the header's other controls; amber only while the
 * agent is waiting on a person, the one colour the dashboard uses for
 * "needs you".
 *
 * On Chat it drives the mounted dock (restore the card, or the theater for
 * an ask), and hides while the card itself is showing. It also waits for
 * the dock (lazy) to mount, so it never flashes a page-navigating control
 * before the card appears. On any other section it is a link to the
 * full-page Computer, deep-linked to the ask when there is one.
 */
export const DesktopHeaderChip = ({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) => {
  const pathname = usePathname();
  const onChat = matchAgentPage(pathname)?.section === "chat";
  // On Chat the dock already polls this key; elsewhere a slow glance is
  // enough to notice an ask.
  const { data } = useDesktop(agentId, { poll: onChat ? "off" : "idle" });
  const dock = useMountedDock(agentId);
  if (!data || dock?.cardShowing || (onChat && !dock)) return null;

  const ask = data.request;
  const named = Array.from(agentName).length <= MAX_NAME_IN_LABEL;
  const content = (
    <>
      <Monitor
        className={
          ask ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
        }
        aria-hidden
      />
      <span>
        {ask ? (
          "Needs you"
        ) : (
          <>
            {named && (
              <span className="max-sm:hidden">{`${agentName}’s `}</span>
            )}
            Computer
          </>
        )}
      </span>
    </>
  );
  const shared = {
    variant: "outline",
    size: "sm",
    // The visible words lead the name, so voice control finds the button
    // by what it reads.
    "aria-label": ask
      ? `Needs you on ${agentName}’s computer: ${ask.reason}`
      : `${agentName}’s Computer`,
    className: cn(
      "animate-in fade-in-0 duration-200 motion-reduce:animate-none pointer-coarse:h-11",
      ask &&
        "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900 dark:hover:text-amber-100",
    ),
  } satisfies React.ComponentProps<typeof Button>;

  return dock ? (
    <Button {...shared} data-desktop-header-chip onClick={dock.show}>
      {content}
    </Button>
  ) : (
    <Button {...shared} asChild>
      <Link href={agentComputerPath(pathname, agentId, ask?.id)}>
        {content}
      </Link>
    </Button>
  );
};
