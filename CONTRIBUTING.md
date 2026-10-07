# Contributing to CDNPanel

Thanks for helping improve CDNPanel.

CDNPanel is source-available and intentionally welcomes community development through GitHub forks, issues, discussions, code review, testing, and pull requests.

Before contributing, read the [LICENSE](LICENSE). The project does **not** use a standard open-source license.

## What contributions are welcome?

Useful contributions include:

- bug fixes;
- security hardening;
- performance improvements;
- new features;
- documentation;
- tests;
- deployment improvements;
- accessibility improvements;
- API improvements;
- database and migration improvements;
- code cleanup and refactors;
- issue reproduction;
- better error handling;
- developer tooling.

If a change is large or changes core architecture, opening an issue first is usually useful so the approach can be discussed before a large amount of code is written.

## Community forks

The CDNPanel license explicitly allows GitHub forks for genuine contribution work.

You may use a community fork to:

- create a feature branch;
- prepare a fix;
- experiment with an implementation;
- reproduce a bug;
- run tests;
- request review;
- demonstrate a proposed change;
- submit a pull request;
- collaborate with other contributors.

A contribution fork must remain an **unofficial CDNPanel development fork**.

It must not be used as:

- an independent CDNPanel distribution;
- a competing project;
- a rebrand;
- a commercial product;
- a paid service;
- a public hosted CDNPanel service;
- an alternative release channel;
- a package or container distribution;
- a mirror intended to replace the official repository.

The full rules are in the [LICENSE](LICENSE).

## Contribution license

You keep copyright ownership in code or other original material you personally create.

By intentionally submitting a contribution to Cache Networks for possible inclusion in CDNPanel, you grant Cache Networks the rights described in Section 5 of the [LICENSE](LICENSE).

In practical terms, this allows Cache Networks to:

- merge your contribution;
- modify it later;
- include it in future CDNPanel releases;
- distribute it with CDNPanel;
- relicense CDNPanel in the future;
- use the contribution in related Cache Networks offerings.

Do not submit material you do not have the right to contribute.

If code comes from another project, library, answer, template, or source, identify it clearly and verify that its license is compatible before submitting it.

## Development setup

### Requirements

- Node.js 22.9+;
- PostgreSQL 14+;
- Redis 6.2+;
- npm;
- Docker and Docker Compose if using the container stack.

### Install

```bash
git clone https://github.com/YOUR-USERNAME/CDNPanel.git
cd CDNPanel
npm install
cp .env.example .env
```

Configure the required local environment values, then generate the database client:

```bash
npm run db:generate
```

For a local database:

```bash
npm run db:migrate
npm run db:seed
```

Build:

```bash
npm run build
```

Run development services:

```bash
npm run dev
```

## Before submitting a pull request

Run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

A pull request should not knowingly reduce security checks, bypass RBAC, disable validation, expose secrets, weaken session protections, or make unsafe proxy assumptions without a very clear reason and discussion.

## Pull-request guidelines

Keep pull requests focused.

A good pull request should explain:

1. **What changed?**
2. **Why is the change needed?**
3. **How was it tested?**
4. **Does it change configuration, migrations, API behaviour, security behaviour, or deployment?**
5. **Are there backwards-compatibility concerns?**

Where practical:

- add tests for new behaviour;
- update documentation;
- avoid unrelated formatting changes;
- avoid mixing multiple unrelated features into one PR;
- preserve existing security controls;
- keep migrations safe for existing installations;
- include screenshots for meaningful UI changes.

## Commit style

There is no requirement for a specific conventional-commit format, but commit messages should be understandable.

Good:

```text
Fix signed URL expiry validation
Add storage provider health check
Improve upload retry handling
Document Dockge deployment
```

Less useful:

```text
fix
stuff
update
changes
```

## API changes

When changing API behaviour:

- keep response formats consistent;
- use existing error structures;
- preserve request IDs;
- update validation;
- update scopes/permissions when needed;
- update OpenAPI metadata;
- add tests;
- avoid silently breaking existing clients.

CDNPanel is structured so route declarations also drive important validation, authentication, authorisation, rate-limit, and OpenAPI behaviour. New routes should follow that pattern.

## Database changes

Database changes should use Prisma migrations.

Do not modify production schema assumptions without providing a safe migration path.

Consider:

- existing rows;
- nullability;
- defaults;
- indexes;
- constraints;
- foreign-key behaviour;
- downgrade/recovery implications;
- large-table performance.

## Security-sensitive changes

Changes touching any of the following should receive extra care:

- authentication;
- sessions;
- password handling;
- TOTP or recovery codes;
- API-key generation or validation;
- encryption;
- master-key rotation;
- CSRF;
- CORS;
- trusted proxies;
- file delivery;
- signed URLs;
- uploads;
- MIME validation;
- path handling;
- webhooks;
- SSRF protections;
- audit logs;
- RBAC;
- rate limiting.

Do not include real secrets, API keys, passwords, session tokens, production database data, or private credentials in issues, commits, screenshots, tests, or pull requests.

## Reporting security issues

Do not publicly post a working exploit against a real deployment.

When possible, provide:

- affected component;
- affected version/commit;
- reproduction steps in a controlled environment;
- expected behaviour;
- actual behaviour;
- security impact;
- suggested mitigation if known.

Security research does not grant permission to access or test systems without authorisation.

## Documentation

Documentation contributions are welcome.

Please keep examples:

- accurate;
- safe by default;
- consistent with the current code;
- explicit where configuration is security-sensitive.

Avoid documentation that tells operators to disable security controls merely to make an error disappear.

## UI contributions

For dashboard changes:

- keep the interface consistent;
- preserve accessibility;
- avoid unnecessary visual complexity;
- support loading, empty, success, and error states;
- preserve permission-aware behaviour;
- do not expose secrets in the browser unnecessarily.

## Tests

Tests should be deterministic and should not depend on public production services.

The project includes unit and integration tests. Integration tests may require PostgreSQL and Redis.

If a bug is easy to reproduce with a regression test, include one.

## Review and acceptance

Submitting a pull request does not guarantee that it will be merged.

A contribution may be:

- accepted;
- requested to change;
- partially adopted;
- reimplemented;
- postponed;
- declined.

Maintainers may edit a contribution before or after merge as needed for consistency, security, maintainability, or future architecture.

## Attribution

Contributors may identify themselves as the author of their original contribution.

Do not remove existing Cache Networks copyright, licensing, or attribution notices.

Do not claim that a community fork is the official CDNPanel project.

## Questions

For normal development questions, use GitHub issues or discussions where available.

For permissions outside the normal community-contribution license — such as commercial use, organisational deployment, redistribution, hosted services, independent packaging, or other licensing — obtain written permission from Cache Networks.

---

Thank you for helping CDNPanel improve while respecting the project's licensing model.
