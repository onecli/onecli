# Security Policy

OneCLI holds credentials and decides which requests they are attached to, so a
security report about it is worth handling carefully. Thank you for taking the
time.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public report
describes the weakness to everyone running OneCLI before there is a version to
upgrade to.

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/onecli/onecli/security) of this
   repository.
2. Click **Report a vulnerability**.
3. Fill in what you found.

That opens a private channel visible only to the maintainers, and it can become
a published advisory with a CVE once a fix is out.

If private reporting is unavailable for any reason, email
**security@onecli.sh** instead, and we will follow up privately from there.

## What to include

Whatever you already have is enough to start a conversation — please don't wait
until a report is polished. The things that help most:

- What an attacker gains, and what they need in order to try.
- The version or commit you observed it on.
- Steps to reproduce, ideally against a disposable instance with dummy
  credentials rather than real ones.
- The relevant code paths, if you found them.

Please use placeholder secrets in anything you send. We do not want your real
tokens, and a report is not a safe place to put them.

## What to expect

- **Acknowledgement within 5 working days.** If you have not heard back by
  then, please do follow up — it means the mail went astray, not that the
  report was dismissed.
- An assessment of severity and affected versions, shared with you.
- Progress updates as a fix comes together, and a chance to review it.
- Credit in the advisory and release notes, unless you would rather stay
  anonymous.

We ask for a **90-day disclosure window**, and we will usually be done well
inside it. If you need to move faster — because the issue is being exploited,
say — tell us and we will work to your timeline instead.

## Scope

In scope is anything that undermines what the gateway promises: an agent
reaching a credential it was not granted, a credential being attached to a
request it should not have been attached to, a policy control not applying
where it says it does, secrets becoming readable outside their intended
boundary, or authentication and tenant isolation failing.

Out of scope: findings against onecli.sh or other hosted infrastructure rather
than this codebase; vulnerabilities in dependencies with no OneCLI-specific
impact (report those upstream); missing hardening headers or scanner output
with no demonstrated impact; and anything requiring an attacker who already has
the privileges the attack obtains.

If you are not sure which side of that line something falls on, report it. We
would rather read a report that turns out to be fine than miss one that is not.

## Safe harbour

We will not pursue or support legal action against anyone who reports in good
faith under this policy — meaning you tested against your own instance, avoided
accessing or destroying other people's data, and gave us a private, reasonable
opportunity to fix the issue before describing it publicly.

OneCLI does not currently run a paid bug bounty.
