# Changelog

## 1.0.2

### Fixed — the verification scanner's findings

1.0.1 was submitted to n8n verification and refused. `npx
@n8n/scan-community-package` reported three defects; provenance and the source
fetch had both passed, so this is the whole of what stood between the package
and a verified badge.

- **The credential class declared no icon.** A credential without one shows as a
  blank tile in the picker.
- **`inputs`/`outputs` used the string literal `'main'`.** The scanner requires
  `NodeConnectionTypes.Main`. The literal works today, but it would not survive
  a rename on n8n's side, and nothing would report it before runtime.
- **Returned items carried no `pairedItem`.** ⚠️ This one was never cosmetic.
  Without it n8n cannot link an output item back to the input that produced it,
  so `$('Physalis').item` does not resolve downstream and expressions must fall
  back to `.first()` — which silently reads the *first* item for *every* one of
  them. A workflow fanning three records out of this node produced three
  messages all describing the first. The node returned correct data and the
  workflow downstream was wrong.

⚠️ **Two lint rules contradict each other on the connection types**, and the
conflict is now pinned in place with two inline `eslint-disable` comments rather
than resolved in configuration — `n8n-nodes-base` demands the literal, and
`@n8n/community-nodes` demands the constant. The disable sits at the code so the
next upgrade of either plugin surfaces it. See the comment in `Physalis.node.ts`.

One scanner **warning** is left unaddressed on purpose: the node icon is a
single file rather than a `{ light, dark }` pair. It does not gate verification.

### Added — `scripts/scan-local.sh`

The scanner only accepts an **already published** package name, so until now the
only way to learn whether a release would pass was to publish it and read the
refusal — at the cost of a version number each time, npm metadata being
immutable. Three versions went that way. The script replays the scanner's two
lint legs against local sources, so the next submission is checked before it is
published. It does not replay provenance, which only a CI run can produce.

## 1.0.1

### Fixed — package authorship

`author` pointed at an email belonging to a **different company**, carried over
from the project's earliest scaffolding. Every published version up to 1.0.0
attributed the package to the wrong organisation, and the owner could not
receive mail sent to it.

⚠️ npm metadata is immutable per version: a published `author` cannot be
corrected in place, only superseded by a new release. Hence 1.0.1 with no code
change — `npm owner` manages maintainers, not this field.

No functional change. If you are on 1.0.0, there is nothing to gain from
upgrading beyond correct attribution.

## 1.0.0

### Breaking — `Execute SQL` and `Send Email` are removed

The package is reduced to what it is actually for: **reading from a Physalis
vault**. Two operations are gone, and they were removed for two *different*
reasons — which is the whole point, because removing only one would have fixed
nothing.

- `Execute SQL` imported `pg` and `mysql2`. A verified community node ships
  **no runtime dependencies**.
- `Send Email` imported nothing at all, but embedded Mailgun. A verified
  community node talks to **exactly one third-party service**.

Both rules gate n8n's verification, and an unverified node is **invisible on
n8n Cloud** — not merely harder to install: there is no workaround, not even
from the command line. Keeping either operation kept every Cloud user out.

Splitting them into `n8n-nodes-physalis-sql` and `-email` was considered and
rejected: those packages would carry the same dependencies, hit the same
refusal, and additionally fall foul of *"the node MUST not be an existing
node"* — n8n already ships Postgres, MySQL and email nodes.

### What you lose, stated plainly

If you self-host and chose Physalis precisely because **nothing is copied into
n8n**, `Execute SQL` was the only way to keep that property on a database
connection. Removing it pushes you to a native node with a real n8n credential
— so the secret *is* copied.

That trade-off is deliberate, not an oversight. Physalis can now write a native
credential from a vault entry and keep it up to date in place (`PATCH`, stable
credential ID), so it rotates and can be revoked from one place, and the
workflows referencing it survive the rotation. You were already pasting those
credentials into n8n by hand; this automates a disclosure you were already
making and makes it revocable. But it is a genuine loss, not a pure gain, and
you should know it before you upgrade rather than discover it after.

### Migration

| Removed | Replacement |
|---|---|
| `Execute SQL` | Native **Postgres** / **MySQL** node + a credential written from your Physalis vault |
| `Send Email` | Native **Send Email** node, same mechanism |

Workflows still using either operation will fail to load the node parameters
after upgrading. Pin `0.4.0` if you need time to migrate.

### Added

- **`usableAsTool`** — the node can now be attached to an AI agent as a tool.
  An agent that reaches third-party APIs without a single key written into the
  workflow is the thing the vault is for.

### Publishing

- Published from GitHub Actions with **npm provenance**
  (`npm publish --provenance`). Required for n8n verification since
  2026-05-01; `0.4.0` was published by hand and carries no attestation, so it
  would have been refused on that ground alone, independently of any code.
- The release workflow refuses to publish if the package declares any runtime
  dependency, or if the git tag does not match `package.json`.

### Docs

- README rewritten in English. The n8n lint rules only cover node property
  labels, so the French README had gone unnoticed against the
  English-documentation criterion.

## 0.4.0

- Read the **team vault**: a `Source` field (Project | Team Vault) for secrets
  that belong to no project and no environment — incoming webhooks, watch keys,
  shared tokens.
- Nodes created before 0.4.0 have no `source` parameter and keep behaving as
  `project`.

## 0.3.0

- `Send Email` operation (Mailgun provider). *Removed in 1.0.0.*

## 0.2.0

- `Execute SQL` operation (PostgreSQL / MySQL / MariaDB). *Removed in 1.0.0.*
