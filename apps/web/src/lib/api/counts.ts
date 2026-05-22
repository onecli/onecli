import { apiGet } from "./client";
import type { ResourceCounts } from "./types";

export const get = () => apiGet<ResourceCounts>("/v1/counts");
