import type { AppDefinition } from "./types";
import { cloudApps as defaultCloudApps } from "../apps/cloud-app-registry";

let _cloudApps: AppDefinition[] = defaultCloudApps;

export const initCloudApps = (apps: AppDefinition[]) => {
  _cloudApps = apps;
};

export const getCloudApps = (): AppDefinition[] => _cloudApps;
