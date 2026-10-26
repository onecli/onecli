import { useAttachSecret } from "@/hooks/use-grants";
import type { SavedSecret } from "@/lib/api";

/**
 * The create-then-attach seam behind every in-place "add a key/secret" door
 * on an agent's page: a workspace secret is on for no agent by default, so
 * one minted from THIS agent's context is attached to it the moment the save
 * completes. SecretDialog's `onSaved` carries the created secret; an edit
 * carries none, so it can never replay an attach.
 *
 * `onSaved` is deliberately recreated per render (never memoized), so
 * `onAttached` is never a stale closure.
 */
export const useCreateThenAttachSecret = (
  agentId: string,
  opts?: { onAttached?: () => void },
) => {
  const attachSecret = useAttachSecret();
  const onAttached = opts?.onAttached;
  const onSaved = (created: SavedSecret | undefined) => {
    if (!created) return;
    attachSecret.mutate(
      { agentId, secretId: created.id },
      onAttached ? { onSuccess: onAttached } : {},
    );
  };
  return { onSaved };
};
