# Contributing to OneCLI

Thank you for your interest in contributing to OneCLI! We'd love to have you contribute. Here are some resources and guidance to help you get started.

- [Getting Started](#getting-started)
- [Issues](#issues)
- [Pull Requests](#pull-requests)
- [License](#license)
- [Contributor License Agreement (CLA)](#contributor-license-agreement-cla)

## Getting Started

To ensure a positive and inclusive environment, please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

### Local Development Setup

```bash
git clone https://github.com/onecli/onecli.git
cd onecli
pnpm install
pnpm dev
```

`pnpm dev` sets everything else up on first run: it creates `.env` with
generated secrets, starts PostgreSQL, applies migrations, and generates the
Prisma client. No values to copy, nothing to fill in.

See the [README](README.md) for more details on prerequisites and configuration.

## Issues

If you find a bug, please create an issue and we'll triage it.

- Please search [existing issues](https://github.com/onecli/onecli/issues) before creating a new one.
- Please include a clear description of the problem along with steps to reproduce it. Screenshots and URLs really help.

## Pull Requests

We actively welcome your Pull Requests! A couple of things to keep in mind before you submit:

- If you're fixing an issue, make sure someone else hasn't already created a PR fixing the same issue. Link your PR to the related issue(s).
- If you're new, we encourage you to take a look at issues tagged with [good first issue](https://github.com/onecli/onecli/labels/good%20first%20issue).
- If you're submitting a new feature, please open an [issue](https://github.com/onecli/onecli/issues/new) first to discuss it before opening a PR.

Before submitting your PR, please run these checks locally:

```bash
pnpm build     # Ensure the project builds
pnpm check     # Lint + types + format
```

Running these before you create the PR will help reduce back and forth during review.

## License

This project is licensed under the [Apache License 2.0](LICENSE), with one
exception: the `ee/` directories hold enterprise features under the [OneCLI
Enterprise License](LICENSE-ENTERPRISE), which enumerates the exact paths it
covers. By contributing, you agree that your contributions will be licensed
under the Apache License 2.0 as well.

---

## Contributor License Agreement (CLA)

All contributions to this repository are made under the [OneCLI Contributor
License Agreement](CLA.md). That document is the canonical text; the summary
below is here so you know what you are agreeing to without clicking through,
but if the two ever differ, [CLA.md](CLA.md) governs.

In short: your contributions are provided under the terms of the Apache
License, Version 2.0, as included in the [LICENSE](LICENSE) file of this
repository, and you grant ChartDB, Inc. ("ChartDB") a perpetual, irrevocable,
worldwide, non-exclusive, royalty-free, sublicensable right and license to:

- Use, copy, modify, distribute, publicly display, publicly perform, and prepare derivative works of your contributions.
- Incorporate your contributions into other works or products.
- Re-license your contributions under a different license at any time in the future, at ChartDB's sole discretion.

You represent and warrant that you have the legal authority to grant these
rights, and that your contributions are original or that you have sufficient
rights to submit them under these terms.

### Signing the CLA

Signing happens once, on your first pull request:

1. Open your PR. If you haven't signed yet, the CLA Assistant bot comments on
   the PR and the CLA status check fails.
2. Read [CLA.md](CLA.md), then reply to the bot's comment with exactly:

   > I have read the CLA Document and I hereby sign the CLA

3. Your signature is recorded against your GitHub account in the
   `onecli/cla-signatures` repository, the check re-runs, and the PR goes
   green. You will not be asked again on future PRs.

If the check doesn't update after you sign, comment `recheck` to re-trigger
it. Submitting a contribution also constitutes acceptance of the CLA on its
own, but the recorded signature is what turns the status check green.

If you do not agree with these terms, you must not contribute your work to this
repository.
