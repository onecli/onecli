"use client";

import { AgentsQuotaWarning } from "./agents-quota-warning";
import { IntegrationCallsWarning } from "./integration-calls-warning";

export const SidebarQuota = () => {
  return (
    <>
      <AgentsQuotaWarning />
      <IntegrationCallsWarning />
    </>
  );
};
