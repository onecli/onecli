import { useMemo, useRef } from "react";
import { useAttachSecret } from "@/hooks/use-grants";
import { secrets as secretsApi } from "@/lib/api";
import type { CreateSecretInput } from "@onecli/api/validations/secret";

/**
 * The create-then-attach seam behind every in-place "add a key/secret" door:
 * SecretDialog's `onSaved` carries no id, so the create call is intercepted
 * (the SecretActions seam) to remember it, and the attach to THIS agent fires
 * after the save completes. The ref is consumed exactly once, so an id-less
 * save (an edit) can never replay a stale attach.
 *
 * `onSaved` is deliberately recreated per render — never memoized — so
 * `onAttached` is never a stale closure.
 */
export const useCreateThenAttachSecret = (
  agentId: string,
  opts?: { onAttached?: () => void },
) => {
  const attachSecret = useAttachSecret();
  const createdSecretId = useRef<string | null>(null);
  const secretActions = useMemo(
    () => ({
      createSecret: async (input: CreateSecretInput) => {
        const created = await secretsApi.create(input);
        createdSecretId.current = created.id;
        return created;
      },
    }),
    [],
  );
  const onAttached = opts?.onAttached;
  const onSaved = () => {
    const secretId = createdSecretId.current;
    createdSecretId.current = null;
    if (!secretId) return;
    attachSecret.mutate(
      { agentId, secretId },
      onAttached ? { onSuccess: onAttached } : {},
    );
  };
  return { secretActions, onSaved };
};
