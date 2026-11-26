/**
 * Builds a backend's payload file path guard. Every substrate enforces the
 * same conservative allowlist on the identical payload (one substrate trust
 * model): an absolute path of at most 300 characters from a narrow character
 * set, with no `..` segment. The wire schema only enforces a non-empty
 * string. Each backend adds the paths it must never write: its own mount
 * points (`exact`) and the directories under which nothing may be written
 * (`prefixes`, each ending in `/`).
 */
export const createInjectablePathGuard =
  (forbidden: { exact: readonly string[]; prefixes: readonly string[] }) =>
  (containerPath: string): void => {
    if (
      containerPath.length > 300 ||
      !/^\/[A-Za-z0-9._/-]+$/.test(containerPath)
    ) {
      throw new Error(
        `payload file path is not an absolute, conservative path: ${containerPath}`,
      );
    }
    if (containerPath.split("/").includes("..")) {
      throw new Error(`payload file path contains "..": ${containerPath}`);
    }
    if (
      forbidden.exact.includes(containerPath) ||
      forbidden.prefixes.some((prefix) => containerPath.startsWith(prefix))
    ) {
      throw new Error(
        `payload file path targets the durable home or a system directory: ${containerPath}`,
      );
    }
  };
