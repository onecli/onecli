"use client";

import { PageHeader } from "@dashboard/page-header";

/** The agent's Apps page banner. The URL segment stays `connections`. */
export const AgentAppsHeader = () => (
  <div className="mb-6">
    <PageHeader
      title="Apps"
      character="cloud-key"
      description="The apps and secrets this agent can use. Writes need your approval."
    />
  </div>
);
