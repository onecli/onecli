import { redirect } from "next/navigation";

interface Props {
  params: Promise<{ workspaceId: string }>;
}

/** The settings index has no content of its own — General is the first pane.
 *  General itself forwards anyone who can't manage the workspace on to
 *  Install, so a member landing here still reaches a pane they can open. */
export default async function WorkspaceSettingsIndex({ params }: Props) {
  const { workspaceId } = await params;
  redirect(`/w/${workspaceId}/settings/general`);
}
