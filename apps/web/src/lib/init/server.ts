import { ensureEditionDefaults } from "@onecli/api";

// Server actions call the shared services directly — they never run
// `createApiApp` — so the edition's process-wide registry defaults (the EE
// app-permission registrations on cloud; a no-op on onprem) must be applied on
// this eager server-init path too. The provider seams themselves (crypto, EE
// apps, role resolver, rule action gate, …) need no init call: each getter
// resolves its edition default at call time.
ensureEditionDefaults();
