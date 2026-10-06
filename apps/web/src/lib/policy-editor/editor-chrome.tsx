"use client";

import { useCallback, useMemo } from "react";
import { useGroups } from "@/hooks/use-groups";
import { useOrgMembersList } from "@/hooks/use-org-members";

/**
 * The policy editor's org-level chrome: directory name resolution for the
 * identities org rules target, and the org-guardrails flag the evaluation
 * explainer reads. Both editions serve the org page, so this runs everywhere;
 * the directory reads are org-admin-gated server-side.
 */

// Stable empty fallback: the admin-gated reads leave `data` permanently
// undefined for non-admins (`retry: false` on a 403), and a fresh `[]`
// default would re-mint each render and defeat every memo downstream.
const EMPTY: never[] = [];

export const useDirectoryNames = (): ((id: string) => string | undefined) => {
  // Org-admin-gated reads — empty for non-admins, in which case an identity
  // falls back to its id.
  const { data: groups = EMPTY } = useGroups();
  const { data: members = EMPTY } = useOrgMembersList(true);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of members) byId.set(m.userId, m.name ?? m.email);
    for (const g of groups) byId.set(g.id, g.name);
    return byId;
  }, [groups, members]);
  return useCallback((id: string) => names.get(id), [names]);
};

/** The EE editions evaluate org guardrails above workspace rules — the
 * explainer describes the two-level model. The OSS arm exports `false`. */
export const ORG_GUARDRAILS_AVAILABLE = true;
