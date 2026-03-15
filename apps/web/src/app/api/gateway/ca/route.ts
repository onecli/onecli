import { NextResponse } from "next/server";
import { loadCaCertificate } from "@/lib/gateway-ca";

export async function GET() {
  const pem = loadCaCertificate();

  if (!pem) {
    return NextResponse.json(
      {
        error:
          "CA certificate not available. Start the gateway first to generate it.",
      },
      { status: 503 },
    );
  }

  return new NextResponse(pem, {
    status: 200,
    headers: {
      "content-type": "application/x-pem-file",
      "content-disposition": 'attachment; filename="onecli-gateway-ca.pem"',
    },
  });
}
