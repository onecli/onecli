# Security Policy

## Reporting a Vulnerability

Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.

Instead, report them privately through either of the following:

- **GitHub Security Advisories** (preferred): use the
  [Report a vulnerability](https://github.com/onecli/onecli/security/advisories/new)
  form on this repository.
- **Email**: security@onecli.sh

Please include as much of the following as you can:

- The type of issue (for example: credential exposure, policy bypass, privilege escalation, SSRF)
- Affected component (`gateway`, `api`, `web`, or the CLI) and version or commit
- Step-by-step instructions to reproduce
- Proof-of-concept, if you have one
- The impact you believe the issue has, including how an attacker might exploit it

## Scope

OneCLI acts as a credential gateway: it stores connected third-party
credentials and injects them into outbound requests on a user's behalf. We are
especially interested in reports concerning:

- Credential disclosure, whether in logs, error responses, or across tenants
- Cross-organization or cross-workspace data access
- Policy engine bypass, where a request reaches a destination a rule should have denied
- Authentication and session handling on the CLI login and API-key flows
- Privilege escalation within an organization's role model

## Response

We aim to acknowledge a report within 3 business days and to provide an
assessment, including a target remediation timeline, within 10 business days.

We will keep you informed as we work on a fix, and we will credit you in the
advisory when the issue is disclosed, unless you would prefer to remain
anonymous.

## Safe Harbour

We will not pursue or support legal action against researchers who:

- Make a good-faith effort to comply with this policy
- Report promptly and do not exploit an issue beyond what is needed to demonstrate it
- Avoid privacy violations, data destruction, and any degradation of our services
- Do not access, modify, or retain data belonging to other users

If you are unsure whether an action is in scope, contact us first at
security@onecli.sh and ask.
