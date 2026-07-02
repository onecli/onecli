import type { AppDefinition } from "./types";
import { eeApps as defaultEeApps } from "../apps/ee-app-registry";

let _eeApps: AppDefinition[] = defaultEeApps;

export const initEeApps = (apps: AppDefinition[]) => {
  _eeApps = apps;
};

export const getEeApps = (): AppDefinition[] => _eeApps;
