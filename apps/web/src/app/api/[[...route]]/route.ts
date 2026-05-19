import { app } from "@/lib/api/app";

const rewrite = async (request: Request) => {
  const url = new URL(request.url);
  url.pathname = `/v1${url.pathname.slice(4)}`;
  return app.fetch(new Request(url.toString(), request));
};

export const GET = rewrite;
export const POST = rewrite;
export const PUT = rewrite;
export const PATCH = rewrite;
export const DELETE = rewrite;
