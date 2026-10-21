"use client";

import { useState } from "react";
import { Library } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useOrgSkillLibrary } from "@/hooks/use-skill-library";
import { LibraryPickerDialog } from "./library-picker-dialog";

export interface AddFromLibraryButtonProps {
  agentId: string;
}

/**
 * Opens the repo picker, shown only when the org has a library connected.
 * The live listing is read when the picker opens (never just to render the
 * button), and the picker shows its errors with Retry.
 */
export const AddFromLibraryButton = ({
  agentId,
}: AddFromLibraryButtonProps) => {
  const [open, setOpen] = useState(false);
  const library = useOrgSkillLibrary();
  if (!library.data?.source) return null;
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
};
