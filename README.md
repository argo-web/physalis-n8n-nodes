# n8n-nodes-physalis

Community n8n node for [Physalis](https://physalis.cloud) — read secrets,
services and app accounts from your Physalis vault directly inside your
workflows, **without copying them into n8n**.

> **Why?** Change a password in Physalis and the workflow picks up the new
> value on its next run. Nothing is stored in clear text inside n8n, and every
> access is recorded in the Physalis audit log.

---

## Installation

In your n8n instance:

1. **Settings → Community Nodes → Install**
2. Enter the package name: `n8n-nodes-physalis`
3. Click **Install**

Once installed, the **Physalis** node appears in the node picker (category
*Development*). It can also be attached to an AI agent as a tool.

---

## Setting up credentials

1. In Physalis, create a Bearer token:
   - **User token** (`sv_user_…`) — Settings → Security → Integration tokens.
     Scoped to your account, grants access to the projects you are a member of.
     ⚠️ Revoked if you leave your organization.
   - **Organization token** (`sv_org_…`) — *recommended for long-lived
     workflows*: Org → Tokens. Scoped to the organization, survives the
     departure of whoever created it, with explicit scopes and an allowlist of
     projects. Requires OrgADMIN.
   - **Machine token** (`sv_…`) — Project → Machine tokens. Locked to a single
     project and environment. Mostly for CI/CD.

2. In n8n: **Credentials → New → Physalis API**, then fill in:
   - **Vault URL** — the URL of your Physalis instance (e.g.
     `https://vault.physalis.cloud`, no trailing slash)
   - **Bearer Token** — the raw token (`sv_user_…`, `sv_org_…` or `sv_…`)

3. Click **Test connection** — it must succeed even if your project list is
   empty.

---

## Operations

### Get Credentials

Reads from one of two sources.

**Source: Project** — secrets, services and app accounts scoped to a project
and an environment. This is what deploys an application.

| Field | Description |
|---|---|
| **Project** | Project slug (loaded dynamically from the API) |
| **Type** | `secret` (env keys/values) · `service` (Stripe, Firebase…) · `account` (app-level account) |
| **Environment** | Required for `secret` only (e.g. `production`) |
| **Tag** | Filter by technical tag (e.g. `postgres`, `stripe`). Loaded dynamically. |
| **Key** | Exact secret key, case-sensitive |

**Source: Team Vault** — shared secrets that belong to no project: incoming
webhook URLs, watch keys, shared tokens. Forcing those into an arbitrary
project is a debt you pay on every automation that follows.

| Field | Description |
|---|---|
| **Collection** | Slug of the team vault collection to read |
| **Tag** | Filter entries by tag. Empty returns the whole collection. |
| **Entry Name** | Exact entry name. Empty returns every matching entry. |

Sample responses:

```json
// type=secret
[
  {
    "key": "DATABASE_URL",
    "value": "postgresql://user:pass@host:5432/db",
    "category": "database",
    "tags": ["postgres", "production"]
  }
]

// type=service
[
  {
    "id": "ck...",
    "name": "Stripe Production",
    "url": "https://stripe.com",
    "username": "admin@example.com",
    "password": "sk_live_...",
    "tags": ["stripe"]
  }
]
```

### List Projects

Lists the projects reachable by the Bearer token, with their environments.
Useful for workflows that iterate over several projects.

```json
[
  {
    "slug": "voyages",
    "name": "Voyages",
    "role": "EDITOR",
    "environments": [
      { "name": "production", "url": "https://app.voyages.fr" },
      { "name": "staging", "url": null }
    ]
  }
]
```

---

## Permissions per token type

| | User token | Org token | Machine token |
|---|---|---|---|
| `getCredentials` — project, secret | ✅ member projects | ✅ explicit scopes + project allowlist | ✅ single project + env |
| `getCredentials` — project, service / account | ✅ member projects | ✅ same | ❌ no service scope for machine tokens |
| `getCredentials` — team vault | ✅ accessible collections | ✅ collection of its organization | ❌ locked to project × env, which a team collection has neither of |
| `listProjects` | ✅ all member projects | ✅ allowed projects (`PROJECTS_LIST` required) | ✅ a single project |

> **OrgSecrets** (organization-wide keys such as `GITHUB_DISPATCH_TOKEN` or
> `REGISTRY_PAT`) are **never** reachable through this node, by design.

---

## Example: using a secret in a native node

The node returns the secret **as data**, so any downstream node can reference
it by expression:

```
[Physalis: Get Credentials]          [HTTP Request]
  source: team_vault            →      url:    {{ $json.value }}
  collection: automation               method: POST
  tag: slack
```

For database or email nodes, see **Migrating from 0.4.x** below.

---

## Security

- The Bearer token travels over TLS — always use `https://`.
- Tokens carry an identifiable prefix (`sv_user_…`, `sv_org_…`, `sv_…`) so
  secret scanners (trufflehog, gitleaks) can catch a leak.
- Revocation is instant from Physalis — the node stops working immediately.
- Every call records `INTEGRATION_CREDENTIALS_FETCH` in the Physalis audit log.

---

## Migrating from 0.4.x

**1.0.0 removes the `Execute SQL` and `Send Email` operations.** A verified n8n
community node must talk to exactly one third-party service and must ship no
runtime dependencies; those two operations broke both rules and kept the whole
package off n8n Cloud. See the [CHANGELOG](CHANGELOG.md) for the full
reasoning, including what is genuinely lost.

| You were using | Use instead |
|---|---|
| `Execute SQL` | The native **Postgres** / **MySQL** node, with its credential written and kept up to date from your Physalis vault |
| `Send Email` | The native **Send Email** node, same mechanism |

Physalis can write a native n8n credential from a vault entry and keep it in
sync in place — the credential ID stays stable, so workflows referencing it
survive a rotation. That path works on n8n Cloud today, which the removed
operations never did.

---

## Local build

```bash
npm install
npm run build       # tsc + gulp icons → dist/
npm run typecheck   # TS validation, no build
npm run lint        # eslint with the n8n-nodes-base rules
```

To test inside a local n8n:

```bash
npm link
cd ~/.n8n/nodes
npm link n8n-nodes-physalis
n8n start
```

---

## License

MIT © [Argoweb](https://argoweb.fr)

---

## Links

- [Physalis](https://physalis.cloud)
- [Physalis documentation](https://physalis.cloud/en/docs)
- [Physalis — n8n integration](https://physalis.cloud/en/docs/n8n-integration)
- [Issues](https://github.com/physalis-cloud/physalis-n8n-nodes/issues)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
