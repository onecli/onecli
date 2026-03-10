import { NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { z } from "zod";
import { validateProxySecret } from "@/lib/proxy-secret";
import { cryptoService } from "@/lib/crypto";

const connectSchema = z.object({
  agent_token: z.string().min(1),
  host: z.string().min(1),
});

interface Injection {
  action: "set_header" | "remove_header";
  name: string;
  value?: string;
}

interface ConnectRule {
  path_pattern: string;
  injections: Injection[];
}

interface GenericInjectionConfig {
  headerName: string;
  valueFormat: string;
}

export async function POST(request: NextRequest) {
  try {
    // Validate proxy secret
    if (!validateProxySecret(request.headers.get("x-proxy-secret"))) {
      return NextResponse.json(
        { error: "Invalid or missing proxy secret" },
        { status: 403 },
      );
    }

    const body = await request.json();
    const parsed = connectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }

    const { agent_token, host } = parsed.data;

    // Look up agent by access token, include policies with their secrets
    const agent = await db.agent.findUnique({
      where: { accessToken: agent_token },
      select: {
        id: true,
        policies: {
          select: {
            secret: {
              select: {
                type: true,
                encryptedValue: true,
                hostPattern: true,
                pathPattern: true,
                injectionConfig: true,
              },
            },
          },
        },
      },
    });

    if (!agent) {
      return NextResponse.json(
        { error: "Invalid agent token" },
        { status: 401 },
      );
    }

    // Filter secrets whose hostPattern matches the requested host
    const matchingSecrets = agent.policies
      .map((p) => p.secret)
      .filter((secret) => hostMatches(host, secret.hostPattern));

    // No matching secrets → tunnel (don't intercept)
    if (matchingSecrets.length === 0) {
      return NextResponse.json({ intercept: false });
    }

    // Build injection rules from matching secrets
    const rules: ConnectRule[] = [];

    for (const secret of matchingSecrets) {
      const decryptedValue = cryptoService.decrypt(secret.encryptedValue);
      const pathPattern = secret.pathPattern ?? "*";
      const injections = buildInjections(
        secret.type,
        decryptedValue,
        secret.injectionConfig,
      );

      rules.push({ path_pattern: pathPattern, injections });
    }

    return NextResponse.json({ intercept: true, rules });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * Check if a requested host matches a secret's host pattern.
 * Supports exact match and wildcard prefix (`*.example.com` matches `api.example.com`).
 */
const hostMatches = (requestHost: string, pattern: string): boolean => {
  if (requestHost === pattern) return true;

  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".example.com"
    return requestHost.endsWith(suffix) && requestHost.length > suffix.length;
  }

  return false;
};

/**
 * Build injection instructions for a secret based on its type.
 */
const buildInjections = (
  type: string,
  decryptedValue: string,
  injectionConfig: unknown,
): Injection[] => {
  switch (type) {
    case "anthropic":
      return [
        { action: "set_header", name: "x-api-key", value: decryptedValue },
        { action: "remove_header", name: "authorization" },
      ];

    case "generic": {
      const config = injectionConfig as GenericInjectionConfig | null;
      if (!config?.headerName) return [];

      const value = config.valueFormat
        ? config.valueFormat.replace("{value}", decryptedValue)
        : decryptedValue;

      return [{ action: "set_header", name: config.headerName, value }];
    }

    default:
      return [];
  }
};
