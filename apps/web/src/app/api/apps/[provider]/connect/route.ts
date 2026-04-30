import { NextRequest, NextResponse } from "next/server";
import { resolveApiAuth } from "@/lib/api-auth";
import { handleServiceError, unauthorized } from "@/lib/api-utils";
import { invalidateGatewayCache } from "@/lib/gateway-invalidate";
import { getApp } from "@/lib/apps/registry";
import {
  createConnection,
  extractLabel,
  listConnectionsByProvider,
  reconnectConnection,
} from "@/lib/services/connection-service";
import { saveAppConfigWithoutDisconnect } from "@/lib/services/app-config-service";

type Params = { params: Promise<{ provider: string }> };

/**
 * POST /api/apps/{provider}/connect
 *
 * Submit credentials for an api_key or credentials_import type connection.
 */
export const POST = async (request: NextRequest, { params }: Params) => {
  try {
    const auth = await resolveApiAuth(request);
    if (!auth) return unauthorized();

    const { provider } = await params;
    const app = getApp(provider);

    if (!app || !app.available || app.connectionMethod.type === "oauth") {
      return NextResponse.json(
        {
          error: `Provider "${provider}" does not support direct credential connections`,
        },
        { status: 400 },
      );
    }

    const body = (await request.json()) as {
      fields?: Record<string, string>;
      connectionId?: string;
    };
    if (!body.fields) {
      return NextResponse.json(
        { error: "Missing fields in request body" },
        { status: 400 },
      );
    }

    let requiredFields: { name: string; label: string }[];
    if (
      app.connectionMethod.type === "credentials_import" &&
      app.connectionMethod.fields.some((f) => f.group)
    ) {
      requiredFields = app.connectionMethod.fields.filter((f) => {
        if (!f.group) return true;
        if (body.fields!.privateKey) return f.group === "service_account";
        return f.group === "authorized_user";
      });
    } else {
      requiredFields = app.connectionMethod.fields;
    }

    for (const field of requiredFields) {
      if (!body.fields![field.name]?.trim()) {
        return NextResponse.json(
          { error: `${field.label} is required` },
          { status: 400 },
        );
      }
    }

    let credentials: Record<string, unknown>;
    let scopes: string[] | undefined;
    let metadata: Record<string, unknown> | undefined;

    if (app.connectionMethod.type === "credentials_import") {
      const result = await app.connectionMethod.exchangeCredentials(
        body.fields,
      );
      credentials = result.credentials;
      scopes = result.scopes;
      metadata = result.metadata;
    } else {
      const primaryField = app.connectionMethod.fields[0];
      credentials = {
        access_token: body.fields[primaryField!.name],
      };
    }

    const connectionOpts = {
      scopes,
      metadata,
    };

    if (body.connectionId) {
      await reconnectConnection(
        auth.projectId,
        body.connectionId,
        credentials,
        connectionOpts,
      );
    } else {
      const existing = await listConnectionsByProvider(
        auth.projectId,
        provider,
      );
      const duplicate = metadata
        ? existing.find((c) => {
            const label = extractLabel(
              c.metadata as Record<string, unknown> | undefined,
            );
            const newLabel = extractLabel(metadata);
            return (
              label &&
              newLabel &&
              label.toLowerCase().trim() === newLabel.toLowerCase().trim()
            );
          })
        : existing[0];

      if (duplicate) {
        await reconnectConnection(
          auth.projectId,
          duplicate.id,
          credentials,
          connectionOpts,
        );
      } else {
        await createConnection(
          auth.projectId,
          provider,
          credentials,
          connectionOpts,
        );
      }
    }

    // For authorized_user credentials_import: persist client credentials as
    // BYOC AppConfig so the gateway can refresh tokens. Service accounts are
    // self-contained (private key stored in AppConnection) and skip this.
    if (
      app.connectionMethod.type === "credentials_import" &&
      !body.fields.privateKey &&
      body.fields.clientId &&
      body.fields.clientSecret
    ) {
      await saveAppConfigWithoutDisconnect(
        auth.projectId,
        provider,
        body.fields.clientId,
        body.fields.clientSecret,
      );
    }

    invalidateGatewayCache(request);

    return NextResponse.json({ success: true });
  } catch (err) {
    return handleServiceError(err);
  }
};
