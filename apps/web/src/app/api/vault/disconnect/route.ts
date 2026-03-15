import { NextResponse } from "next/server";
import { db } from "@onecli/db";
import { getServerSession } from "@/lib/auth/server";
import { getGatewayBaseUrl, getGatewaySecret } from "@/lib/gateway-secret";

export async function DELETE() {
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

    // Forward disconnect to gateway
    const gatewaySecret = getGatewaySecret();
    const gatewayUrl = `${getGatewayBaseUrl()}/api/remote/pair`;

    try {
      await fetch(gatewayUrl, {
        method: "DELETE",
        headers: gatewaySecret ? { "x-gateway-secret": gatewaySecret } : {},
      });
    } catch {
      // Gateway unreachable — still remove DB record
    }

    // Remove DB record
    await db.vaultConnection.deleteMany({
      where: { userId: user.id },
    });

    return NextResponse.json({ status: "disconnected" });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
