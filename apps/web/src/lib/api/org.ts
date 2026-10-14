import { apiGet } from "./client";
import type { OrgInfo, OrgMembership } from "./types";

export const get = () => apiGet<OrgInfo>("/v1/org");

/** The caller's standing in the current org (display only). */
export const membership = () => apiGet<OrgMembership>("/v1/org/membership");
