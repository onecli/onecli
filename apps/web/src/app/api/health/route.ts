import { NextResponse } from "next/server";
import pkg from "../../../../../../package.json";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    version: pkg.version,
    timestamp: new Date().toISOString(),
  });
}
