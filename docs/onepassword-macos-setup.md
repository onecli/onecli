# 1Password Integration — macOS Setup

## Full Disk Access Requirement

On macOS Sequoia (15.0+), the `op` CLI probes `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/` during initialization — even when using a Service Account Token. macOS attributes this file access to the **parent process** (OneCLI), not `op` itself.

This triggers a system dialog:

> **"[terminal/app]" would like to access data from other apps**

### Granting access

1. Open **System Settings → Privacy & Security → Full Disk Access**
2. Add your terminal app (Terminal.app, iTerm2, etc.) or the OneCLI binary
3. The grant persists across sessions but **resets when the binary is updated** (e.g., Homebrew upgrades change the Cellar path)

### Docker / Linux

Not affected — no desktop app or Group Containers in container environments.

### Workaround for service/daemon use

If running OneCLI as a background service (launchd, etc.), the process has no terminal to inherit FDA from. Options:

- Grant FDA directly to the OneCLI binary (resets on upgrade)
- Wrap in a minimal `.app` bundle with a stable `CFBundleIdentifier` — TCC keys grants to bundle ID, not binary path, so grants survive upgrades

### References

- [1Password Community: CLI causes TCC warning](https://1password.community/discussions/1password/1password-cli-op-command-causes-would-like-to-access-data-from-other-apps--warni/168186)
- [1Password SDK docs](https://developer.1password.com/docs/sdks/) — future alternative that avoids TCC entirely
