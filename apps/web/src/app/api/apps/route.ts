import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { apps } from "@/lib/apps/registry";
import { listConnections } from "@/lib/services/connection-service";
import { db } from "@onecli/db";

export const GET = async (request: NextRequest) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const [configs, connections] = await Promise.all([
      db.appConfig.findMany({
        where: { accountId: auth.accountId },
        select: {
          provider: true,
          enabled: true,
          credentials: true,
          createdAt: true,
        },
      }),
      listConnections(auth.accountId),
    ]);

    const configMap = new Map(configs.map((c) => [c.provider, c]));
    const connectionMap = new Map(connections.map((c) => [c.provider, c]));

    const result = apps.map((app) => {
      const config = configMap.get(app.id);
      const connection = connectionMap.get(app.id);

      return {
        id: app.id,
        name: app.name,
        available: app.available,
        connectionType: app.connectionMethod.type,
        configurable: !!app.configurable,
        config: config
          ? {
              hasCredentials: !!config.credentials,
              enabled: config.enabled,
            }
          : null,
        connection: connection
          ? {
              status: connection.status,
              scopes: connection.scopes,
              connectedAt: connection.connectedAt,
            }
          : null,
      };
    });

    return NextResponse.json(result);
  } catch (err) {
    return handleServiceError(err);
  }
};
