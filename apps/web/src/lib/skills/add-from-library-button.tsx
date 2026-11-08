"use client";

import { useState } from "react";
import Link from "next/link";
import { Library } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useOrgMembership } from "@/hooks/use-org";
import { useOrgSkillLibrary } from "@/hooks/use-skill-library";
import { readDefaultOrgCookie } from "@/lib/navigation";
import { LibraryPickerDialog } from "./library-picker-dialog";

export interface AddFromLibraryButtonProps {
  agentId: string;
}

/**
 * The agent's library button. With a library connected it opens the repo
 * picker (the live listing is read when the picker opens, never just to
 * render the button). Without one, org admins get "Add to library", a link
 * to the org Skills page where the library is connected; everyone else sees
 * nothing, since only an admin could act on it. Nothing renders until the
 * library and membership reads answer, so the button never flashes.
 */
export const AddFromLibraryButton = ({
  agentId,
}: AddFromLibraryButtonProps) => {
  const [open, setOpen] = useState(false);
  const library = useOrgSkillLibrary();
  const connected = !!library.data?.source;
  const { data: membership } = useOrgMembership(!connected);

  if (connected) {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Library className="size-4" />
          Add from library
        </Button>
        <LibraryPickerDialog
          agentId={agentId}
          open={open}
          onOpenChange={setOpen}
        />
      </>
    );
  }

  // Unknown (still loading, or the read failed): show nothing rather than
  // offer a link that may be wrong.
  if (library.isPending || !membership?.isAdmin) return null;
  // The workspace's org, written by the workspace layout in every edition.
  // Read only past the guards above, so never on the server.
  const orgId = readDefaultOrgCookie();
  if (!orgId) return null;

  return (
    <Button size="sm" variant="outline" asChild>
      <Link href={`/org/${encodeURIComponent(orgId)}/skills`}>
        <Library className="size-4" />
        Add to library
      </Link>
    </Button>
  );
};
