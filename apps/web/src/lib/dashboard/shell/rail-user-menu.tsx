"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BookOpen,
  CreditCard,
  KeyRound,
  Loader2,
  LogOut,
  Moon,
  Sun,
  User,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@onecli/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@onecli/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@onecli/ui/components/tooltip";
import { useAuth } from "@/providers/auth-provider";
import { useOrgMembership } from "@/hooks/use-org";
import { CAPS } from "@/lib/env";
import { isOrgScopedPath } from "@/lib/navigation";
import { useSettingsHref } from "@/lib/settings-modal/use-settings-href";
import { DiscordIcon } from "@/lib/dashboard/discord-icon";

const userInitials = (displayName: string): string =>
  displayName
    .split(/\s+/)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

/**
 * The rail's bottom square: the signed-in person, and their menu. Profile,
 * API keys and (for admins, where plans are sold) Billing open the Settings
 * modal; the theme toggle lives here and nowhere else; Docs and Discord
 * leave; then sign out.
 */
export const RailUserMenu = () => {
  const { user, signOut } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();
  const settingsHref = useSettingsHref();
  // The Settings modal opens over a page that names an org. The account's
  // own page (in the shell only for a viewer with no org) is the profile
  // already, and has no org for API keys or billing.
  const orgScoped = isOrgScopedPath(usePathname());
  // Billing & usage: on editions that bill, for the org's admins (the
  // settings modal shows the page to them alone). Asked only where the URL
  // names an org: on the account's own page there is none to ask about.
  const { data: membership } = useOrgMembership(CAPS.billing && orgScoped);
  const showBilling = CAPS.billing && membership?.isAdmin === true;
  const [signingOut, setSigningOut] = useState(false);

  const displayName = user?.name ?? user?.email ?? "User";
  const dark = resolvedTheme === "dark";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account"
              className="focus-visible:ring-ring data-[state=open]:ring-ring hover:border-foreground/30 flex size-9 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 data-[state=open]:ring-2"
            >
              <Avatar className="border-border/80 size-8 border shadow-xs">
                <AvatarFallback className="bg-background/60 text-foreground/80 text-xs font-medium">
                  {userInitials(displayName)}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Account</TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="end" className="w-60 rounded-lg">
        <DropdownMenuLabel className="font-normal">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="truncate text-sm leading-none font-medium">
              {displayName}
            </p>
            {user?.email && (
              <p className="text-muted-foreground truncate text-xs leading-none">
                {user.email}
              </p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={orgScoped ? settingsHref("profile") : "/account"}>
            <User />
            Profile
          </Link>
        </DropdownMenuItem>
        {orgScoped && (
          <DropdownMenuItem asChild>
            <Link href={settingsHref("api-keys")}>
              <KeyRound />
              API keys
            </Link>
          </DropdownMenuItem>
        )}
        {showBilling && (
          <DropdownMenuItem asChild>
            <Link href={settingsHref("billing")}>
              <CreditCard />
              Billing
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setTheme(dark ? "light" : "dark")}>
          {dark ? <Sun /> : <Moon />}
          {dark ? "Light theme" : "Dark theme"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a
            href="https://onecli.sh/docs"
            target="_blank"
            rel="noopener noreferrer"
          >
            <BookOpen />
            Docs
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a
            href="https://discord.gg/PSztzsQB3g"
            target="_blank"
            rel="noopener noreferrer"
          >
            <DiscordIcon className="size-4" />
            Discord
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={async (event) => {
            event.preventDefault();
            setSigningOut(true);
            try {
              await signOut();
            } catch {
              setSigningOut(false);
            }
          }}
        >
          {signingOut ? <Loader2 className="animate-spin" /> : <LogOut />}
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
