"use client";

import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useCreateThenAttachSecret } from "@/hooks/use-create-then-attach-secret";
import { SecretDialog } from "@/app/(dashboard)/w/[workspaceId]/connections/_components/secret-dialog";
import { ConnectAppPickerDialog } from "./connect-app-picker-dialog";

/**
 * The agent section's own "Add connection" door: connect an app (or mint a
 * custom secret) WITHOUT leaving the agent, and wire this agent up to it the
 * moment it lands. The workspace Connections page keeps the full management
 * surface; this is the shortest path from "my agent needs X" to "it has X" —
 * the same auto-grant contract the chat's connector card makes.
 *
 * The open state is the section's (controlled), so the tabs' empty states can
 * open the same dialogs — one owner for the door, many triggers.
 */
export const AddConnectionButton = ({
  agentId,
  tab,
  pickerOpen,
  onPickerOpenChange,
  secretOpen,
  onSecretOpenChange,
}: {
  agentId: string;
  /** Which tab the section shows — apps opens the picker, custom the secret
   *  dialog. The button label stays the same; the door differs. */
  tab: "apps" | "custom";
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
  secretOpen: boolean;
  onSecretOpenChange: (open: boolean) => void;
}) => {
  const pathname = usePathname();

  // Create-then-attach for the custom tab: a secret minted here is granted
  // to THIS agent the moment it lands (the shared SecretActions seam).
  const { secretActions, onSaved: onSecretSaved } =
    useCreateThenAttachSecret(agentId);

  return (
    <>
      <Button
        size="sm"
        onClick={() =>
          tab === "apps" ? onPickerOpenChange(true) : onSecretOpenChange(true)
        }
      >
        <Plus className="size-3.5" aria-hidden />
        Add connection
      </Button>

      {/* Apps: the shared catalog picker. Connect opens the OAuth popup; on
          landing the new account is granted to this agent automatically, then
          the permissions sheet opens for exactly that account. */}
      <ConnectAppPickerDialog
        agentId={agentId}
        open={pickerOpen}
        onOpenChange={onPickerOpenChange}
        onGranted={(connectionId) => {
          // Land the user in the permissions sheet for what they just
          // added — the apps section's own `?connection=&manage=1` deep
          // link, so this stays one mechanism with one owner. Shallow (the
          // section's own tab-switcher pattern — Next syncs useSearchParams
          // over replaceState, no RSC round-trip); `tab` is dropped
          // deliberately because the sheet lives on the Apps tab, everything
          // else in the URL survives.
          const params = new URLSearchParams(window.location.search);
          params.delete("tab");
          params.set("connection", connectionId);
          params.set("manage", "1");
          window.history.replaceState(
            null,
            "",
            `${pathname}?${params.toString()}`,
          );
        }}
      />

      {/* Custom: the existing secret dialog, with attach-on-create. */}
      <SecretDialog
        open={secretOpen}
        onOpenChange={onSecretOpenChange}
        onSaved={onSecretSaved}
        defaultType="generic"
        secretActions={secretActions}
      />
    </>
  );
};
