import { NextRequest, NextResponse } from "next/server";
import { db } from "@onecli/db";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server";
import { getGatewayBaseUrl, getGatewaySecret } from "@/lib/gateway-secret";

const pairSchema = z.object({
  psk_hex: z.string().length(64, "PSK must be 64 hex characters"),
  fingerprint_hex: z
    .string()
    .length(64, "Fingerprint must be 64 hex characters"),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = pairSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid request" },
        { status: 400 },
      );
    }

    // Forward to gateway's remote access pairing endpoint
    const gatewaySecret = getGatewaySecret();
    const gatewayUrl = `${getGatewayBaseUrl()}/api/remote/pair/psk`;

    const gatewayResp = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(gatewaySecret ? { "x-gateway-secret": gatewaySecret } : {}),
      },
      body: JSON.stringify({
        psk_hex: parsed.data.psk_hex,
        fingerprint_hex: parsed.data.fingerprint_hex,
      }),
    });

    if (!gatewayResp.ok) {
      const error = await gatewayResp.text();
      return NextResponse.json(
        { error: `Gateway pairing failed: ${error}` },
        { status: gatewayResp.status },
      );
    }

    // Store vault connection in database
    const user = await db.user.findUnique({
      where: { externalAuthId: session.id },
      select: { id: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    await db.vaultConnection.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        fingerprint: parsed.data.fingerprint_hex,
        status: "paired",
        lastConnectedAt: new Date(),
      },
      update: {
        fingerprint: parsed.data.fingerprint_hex,
        status: "paired",
        lastConnectedAt: new Date(),
      },
    });

    return NextResponse.json({ status: "paired" });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
