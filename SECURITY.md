# Security Policy

## Supported versions

This project is pre-1.0. Only the latest published minor release receives security fixes; please upgrade before
reporting.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting:
https://github.com/har1101/strands-lambda-durable-functions/security/advisories/new

Do not open public issues, pull requests or discussions for security problems.

Please include:

- the affected version(s)
- steps or a minimal code sample that reproduces the issue
- the impact you expect (what an attacker can do, under which conditions)

This is a volunteer-maintained project. Reports are handled on a best-effort basis; there is no response-time SLA.

## Scope

In scope: the code in this repository and its release pipeline (GitHub Actions workflows, published npm package and
GitHub release artifacts).

Out of scope: vulnerabilities in `@strands-agents/sdk`, `@aws/durable-execution-sdk-js` or AWS services. Report
those to the respective projects or to AWS.
