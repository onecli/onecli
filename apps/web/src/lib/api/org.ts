import { apiGet } from "./client";
import type { OrgInfo } from "./types";

export const get = () => apiGet<OrgInfo>("/v1/org");
