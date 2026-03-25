# OneCLI

Cloud backend for OneCLI — manages authentication, integrations, and permissions for the OneCLI agent gateway.

## Commands

```bash
pnpm dev          # Start development
pnpm build        # Build all
pnpm check        # Lint + types + format
pnpm fix          # Auto-fix lint + format
pnpm db:generate  # Generate Prisma client
pnpm db:migrate   # Run migrations (dev)
pnpm db:studio    # Open Prisma Studio
```

## Structure

```
apps/web/         # Next.js 16 app (App Router)
packages/db/      # Prisma ORM + migrations
packages/infra/   # AWS CDK infrastructure
packages/ui/      # Shared components (shadcn/ui)
packages/eslint-config/
packages/typescript-config/
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string
- `NEXT_PUBLIC_COGNITO_*`: AWS Cognito config (injected at build time in CI)
- `STRIPE_SECRET_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Third-party credentials

## Code Style

- **Use strong typing** - leverage types from external packages; avoid `any` and type assertions
- Prefer named exports over default exports (except Next.js pages/layouts where required)
- Use `@onecli/ui/*` for shared UI imports, `@/` for app-local imports
- Use `cn()` for class merging
- Mark client components with `"use client"`
- Prefer Tailwind utilities over custom CSS
- Use const arrow functions, not function declarations (for components and utilities)

## Component Structure

- **One component per file** - never put multiple components in the same file (includes page.tsx)
- **Page-specific components** - create `_components/` subdirectory in the route folder:
  ```
  app/(dashboard)/overview/
  ├── page.tsx
  └── _components/
      ├── overview-header.tsx
      └── recent-activity.tsx
  ```
- **Props typing** - use base types directly, only create named interface when adding custom props:

  ```tsx
  // ✓ No custom props - use base type directly
  export const Card = ({ className, children, ...props }: React.ComponentProps<"div">) => { ... };

  // ✓ Custom props - create interface
  export interface ServiceCardProps extends React.ComponentProps<"div"> {
    connected?: boolean;
  }
  ```

- **Multi-component features**: Create a directory with an `index.ts` barrel export

## IMPORTANT: shadcn/ui Components

Components in `packages/ui/src/components/` are from shadcn/ui.

**Allowed:**

- Adding new variants/sizes to CVA definitions
- Customizing via `className` when using components
- Wrapping in your own component

**NOT Allowed:**

- Changing existing variant styles
- Modifying component structure or logic
- Removing existing functionality

When adding components, use shadcn CLI or copy from ui.shadcn.com.

## Dependencies

- Use Radix UI only through shadcn/ui, never import directly
- Check shadcn for components before adding dependencies
- Keep bundle size small - prefer lightweight alternatives

## Web App Patterns

- Server components by default, add `"use client"` only when needed
- Pages export `default function` (async for data fetching)
- Auth: AWS Amplify + Cognito (React context in `providers/`)
- Server-side auth: `getServerSession()` from `lib/auth.ts`
- Validation: Zod for API inputs
- **Button loading states** - replace icon with spinner, update text (e.g., "Connecting..."), and disable
- **Verify library APIs are current** - check official docs for deprecated/legacy patterns before implementing

## Audit Logging

All state-changing operations (create, update, delete, regenerate) must be audited. Use the `withAudit` wrapper from `@/lib/services/audit-service`.

**Pattern:**

```typescript
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@/lib/services/audit-service";

export const createAgent = async (name: string) => {
  const { userId, accountId } = await resolveUser();
  return withAudit(
    () => createAgentService(accountId, name),
    (agent) => ({
      accountId,
      userId,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId: agent.id, name },
    }),
  );
};
```

**Available constants:**

- `AUDIT_ACTIONS`: `CREATE`, `UPDATE`, `DELETE`, `REGENERATE`
- `AUDIT_SERVICES`: `AGENT`, `SECRET`, `RULE`, `API_KEY`

**Metadata guidelines:**

- Include resource IDs (agentId, secretId, ruleId)
- Include relevant identifiers (name, type)
- Never include sensitive values (tokens, secrets, passwords)

**When to audit:**

- Actions layer (`lib/actions/`) - always use `withAudit`
- API routes (`app/api/`) - call audit service directly with `source: AUDIT_SOURCE.API` (when implemented)
- Read operations - do not audit

## Database (Prisma)

- Schema at `packages/db/prisma/schema.prisma`
- Always run `pnpm db:generate` after schema changes
- Migrations run automatically on container startup via `entrypoint.sh`

## Infrastructure & Deployment

- Environment passed via CDK context: `--context env=dev|prod`
- **IMPORTANT: Never modify AWS resources directly** — all changes go through CDK stacks and GitHub Actions workflows
- Both deploy workflows (`deploy-app.yml`, `deploy-infra.yml`) are manual with environment choice (dev/prod)
