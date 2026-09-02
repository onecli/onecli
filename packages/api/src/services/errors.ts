export type ServiceErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "UNPROCESSABLE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "GONE"
  | "RATE_LIMITED";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ServiceError";
  }
}
