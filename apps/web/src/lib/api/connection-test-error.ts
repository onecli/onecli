/** A refused connection check, with the gateway's code (e.g.
 *  `SERVER_NO_TLS`) so the dashboard can add the matching help. Its own
 *  module, so a test can mock the fetch without re-providing this class. */
export class ConnectionTestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ConnectionTestError";
  }
}
