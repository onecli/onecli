import { NextResponse } from "next/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { getGatewayBaseUrl, getGatewaySecret } from "@/lib/gateway-secret";

export async function GET() {
  try {
    const session = await getServerSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Get local DB record
    const connection = await db.vaultConnection.findUnique({
      where: { userId: user.id },
      select: {
        fingerprint: true,
        name: true,
        status: true,
        lastConnectedAt: true,
        createdAt: true,
      },
    });

    // Get live status from gateway
    const gatewaySecret = getGatewaySecret();
    const gatewayUrl = `${getGatewayBaseUrl()}/api/remote/status`;

    let gatewayStatus = null;
    try {
      const gatewayResp = await fetch(gatewayUrl, {
        headers: gatewaySecret ? { "x-gateway-secret": gatewaySecret } : {},
      });
      if (gatewayResp.ok) {
        gatewayStatus = await gatewayResp.json();
      }
    } catch {
      // Gateway unreachable — return DB-only status
    }

    return NextResponse.json({
      connection,
      gateway: gatewayStatus,
    });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
