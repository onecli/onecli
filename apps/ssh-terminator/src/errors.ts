/** Thrown for a missing/mis-shaped boot configuration — fail at boot with a
 * clear message, never an endless stream of hint-free 401s. The class NAME is
 * load-bearing: the entrypoint boot test asserts the literal "ConfigError" in
 * an empty-env boot's output. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
