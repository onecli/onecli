import { createApiApp } from "@onecli/api";
import { nextSessionProvider } from "./session-provider";
import { cloudOverrides } from "@/lib/api/cloud-overrides";

export const app = createApiApp(nextSessionProvider, cloudOverrides);
