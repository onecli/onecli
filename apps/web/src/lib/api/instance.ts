import { apiGet } from "./client";
import type { InstanceInfo } from "./types";

export const get = () => apiGet<InstanceInfo>("/v1/instance");
