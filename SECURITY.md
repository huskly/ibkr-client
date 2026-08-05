# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately by email:

**github.revolt195@passmail.com**

Do not report security vulnerabilities in a public GitHub issue, pull request,
discussion, or other public channel. A public report can put users at risk
before a fix is available.

Please include the following information when possible:

- A short description of the vulnerability.
- The affected version, commit, or package configuration.
- The security impact and a realistic attack scenario.
- Clear steps to reproduce the issue.
- A minimal proof of concept, if available.
- Any suggested mitigation or fix.

Remove secrets and private data before sending a report. Do not include OAuth
tokens, private keys, `.pem` files, account identifiers, personal information,
or live trading credentials. Do not test a suspected vulnerability against an
account or system that you do not own or have permission to use.

## What to Expect

We will review private reports and reply when we have assessed them. We may
ask for more information to reproduce or understand the issue.

If the report is valid, we will work on a fix or mitigation and coordinate the
release and disclosure timeline with the reporter when appropriate. Please do
not publicly disclose the vulnerability until we have agreed that disclosure
is safe.

## Security Updates

Security fixes will be published through the normal project release process.
Users should update to the latest available version and review the release
notes for security-related changes.

## Scope

This policy applies to the code and package published from this repository.
For vulnerabilities in Interactive Brokers services, OAuth credentials, or
other third-party systems, contact the relevant provider as well as notifying
us if the issue affects this client.
