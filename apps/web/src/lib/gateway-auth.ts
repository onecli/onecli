export const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:10255";

export const getGatewayFetchOptions = (): RequestInit => ({
  credentials: "include",
});
