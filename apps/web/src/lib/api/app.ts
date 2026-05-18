import { createApiApp } from "@onecli/api";
import { nextSessionProvider } from "./session-provider";
import { cloudOverrides } from "@/lib/init/api";

export const app = createApiApp(nextSessionProvider, cloudOverrides);
