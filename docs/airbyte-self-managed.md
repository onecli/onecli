# Airbyte (Self-Managed)

OneCLI can connect to the Public API of a self-managed Airbyte deployment. This connection is not for Airbyte Cloud, which uses a separate host and authentication flow.

## What you need

Create an application in your self-managed Airbyte instance and enter these values in OneCLI:

- Airbyte instance URL, such as `https://airbyte.example.com`
- Application client ID
- Application client secret

Use the instance origin only. Reverse-proxy subpaths such as `https://example.com/airbyte` are not supported by the initial integration.

## How requests work

OneCLI derives the two Airbyte endpoints from the instance origin:

- Public API: `/api/public/v1`
- Application token exchange: `/api/v1/applications/token`

Agents call the configured Public API URL directly without adding an `Authorization` header. The gateway exchanges the application credentials for short-lived access tokens, refreshes them when needed, and injects the Bearer token only for the exact configured host, port, and Public API path.

Token requests require HTTPS, stop after ten seconds, and do not follow redirects. Private and internal hosts are intentionally supported because self-managed Airbyte deployments commonly run inside a private network. When role-based access control is active, only organization admins and owners can create this connection. The initial integration creates project-scoped connections only.

## Multiple instances

Each Airbyte instance is stored as a separate connection. OneCLI identifies an existing connection by its normalized Public API URL, so reconnecting one instance does not overwrite another instance that happens to use the same display label.
