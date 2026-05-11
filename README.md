# n8n-nodes-physalis

Nœud N8n communautaire pour [Physalis](https://physalis.cloud) — récupère
secrets, services et comptes applicatifs depuis ton vault Physalis
directement dans tes workflows N8n, sans dupliquer les credentials.

> **Pourquoi ?** Si tu changes un mot de passe dans Physalis, le workflow
> N8n l'utilise automatiquement à la prochaine exécution. Aucun secret
> stocké en clair dans N8n. Chaque accès est tracé dans l'audit log
> Physalis.

---

## Installation

Dans ton instance N8n :

1. **Settings → Community Nodes → Install**
2. Coller le nom du package : `n8n-nodes-physalis`
3. Cliquer sur « Install »

Une fois installé, le nœud **Physalis** apparaît dans le node picker
(catégorie « Development »).

---

## Configuration des credentials

1. Dans Physalis, génère un token Bearer :
   - **Token utilisateur** (`sv_user_…`) : Settings → Sécurité → Tokens
     d'intégration. Scopé à ton compte, accès aux projets dont tu es
     membre. ⚠️ Révoqué si tu quittes ton organisation.
   - **Token organisation** (`sv_org_…`) — *recommandé pour les
     workflows pérennes* : Org → Tokens. Scopé à l'organisation, survit
     au départ du créateur, scopes explicites + liste de projets
     autorisés. Réservé OrgADMIN.
   - **Token machine** (`sv_…`) : Project → Machine tokens. Scopé à un
     projet + un environnement précis. Pour CI/CD principalement.

2. Dans N8n : **Credentials → New → Physalis API** et remplir :
   - **Vault URL** : URL de ton instance Physalis (ex:
     `https://vault.physalis.cloud` — sans slash final)
   - **Bearer Token** : le token brut (`sv_user_…`, `sv_org_…` ou `sv_…`)

3. Cliquer sur « Test connection » — doit répondre OK même si la liste
   de projets est vide.

---

## Opérations supportées

### Send Email (V0.3.0+)

Envoie un email via **Mailgun** (US ou EU), avec credentials stockés
dans Physalis ou remplis manuellement.

> V1 : provider Mailgun seul. V2 prévu : SendGrid, SMTP, AWS SES.

**Convention de stockage côté Physalis** :

Secrets dans un environnement, taggés `mailgun` (ou un autre tag de ton
choix — configurable dans le nœud). Le parser accepte plusieurs alias :

| Champ requis | Noms acceptés |
|---|---|
| **API Key** | `MAILGUN_API_KEY`, `MAILGUN_KEY`, `MAILGUN_SECRET_KEY`, `API_KEY`, `EMAIL_API_KEY` |
| **Domain** | `MAILGUN_DOMAIN`, `MAIL_DOMAIN`, `EMAIL_DOMAIN`, `DOMAIN`, `SENDING_DOMAIN` |

| Champ optionnel | Noms acceptés | Défaut |
|---|---|---|
| **Region** | `MAILGUN_REGION`, `EMAIL_REGION`, `REGION` | `us` (sinon `eu`) |
| **Default From** | `MAILGUN_FROM`, `EMAIL_FROM`, `FROM`, `FROM_EMAIL`, `SENDER`, `DEFAULT_FROM` | — (override par le champ From du nœud sinon obligatoire) |

**Champs du nœud** :

| Champ | Description |
|---|---|
| **From** | `Name <addr@domain>` ou `addr@domain`. Fallback sur le secret FROM si vide. |
| **To** | Une ou plusieurs adresses séparées par virgules |
| **Subject** | Sujet du mail |
| **Text Body** | Plain text (au moins un body requis : text ou HTML) |
| **HTML Body** | HTML (multipart alternative si combiné avec Text) |
| **CC** / **BCC** | Destinataires copie / copie cachée (csv) |
| **Reply To** | Header Reply-To |
| **Tags** | Mailgun analytics tags (max 3) — csv |

**Exemple** :

```
[Webhook]                    [Physalis: Send Email]
  → email, name         →    Source: From Physalis
                             Project: voyages
                             Env: production
                             Tag: mailgun
                             From: Acme <noreply@mg.acme.fr>
                             To: {{ $json.email }}
                             Subject: Welcome {{ $json.name }}
                             HTML Body: <h1>Hi {{ $json.name }}</h1>
                             Tags: welcome, onboarding
```

**Sortie** : 1 item N8n avec `{ ok, provider, region, id, message, from, to, subject }`. Sur erreur Mailgun (4xx/5xx), throw `NodeOperationError` avec le détail du serveur.

---

### Execute SQL (V0.2.0+)

Connecte-toi à une base PostgreSQL / MySQL / MariaDB et exécute du SQL,
avec credentials récupérés depuis Physalis ou remplis manuellement dans
le nœud.

**Source des credentials** :

| Mode | Description |
|---|---|
| **From Physalis** (recommandé) | Récupère 5 Secrets dans Physalis taggés `postgres` / `mysql` / `mariadb` |
| **Manual** | Remplit `host`, `port`, `user`, `password`, `database` directement dans le nœud |

**Convention de stockage côté Physalis** (mode From Physalis) :

Pour chaque base de données, crée des Secrets dans un environnement,
tous taggés avec le type de DB (`postgres`, `mysql` ou `mariadb`). Le
parser accepte **plusieurs conventions de naming** (case-insensitive,
première clé trouvée prioritaire) :

| Champ requis | Noms acceptés |
|---|---|
| **Host** | `HOST`, `POSTGRES_HOST`, `MYSQL_HOST`, `MARIADB_HOST`, `DB_HOST`, `HOST_NAME`, `HOSTNAME` |
| **User** | `USER`, `POSTGRES_USER`, `MYSQL_USER`, `MARIADB_USER`, `DB_USER`, `USERNAME` |
| **Password** | `PASSWORD`, `POSTGRES_PASSWORD`, `MYSQL_PASSWORD`, `MARIADB_PASSWORD`, `DB_PASSWORD`, `PWD` |
| **Database** | `DATABASE`, `POSTGRES_DB`, `POSTGRES_DATABASE`, `MYSQL_DATABASE`, `MARIADB_DATABASE`, `DB_NAME`, `DB_DATABASE`, `DATABASE_NAME` |

| Champ optionnel | Noms acceptés | Défaut |
|---|---|---|
| **Port** | `PORT`, `POSTGRES_PORT`, `MYSQL_PORT`, `MARIADB_PORT`, `DB_PORT` | 5432 (PG) / 3306 (MySQL/MariaDB) |

**Fallback URL** : si un secret `DATABASE_URL`, `POSTGRES_URL`,
`MYSQL_URL` ou `MARIADB_URL` est présent, son contenu est parsé et
comble les champs manquants. Les clés discrètes ci-dessus prennent
priorité sur les composants de l'URL (utile quand ton `DATABASE_URL`
pointe sur `localhost` mais que tu veux utiliser le hostname Docker
via `HOST_NAME`).

**Exemple typique** (convention Docker / .env Postgres) :
```
POSTGRES_USER=voyages
POSTGRES_PASSWORD=voyages
POSTGRES_PORT=5432
HOST_NAME=voyages-postgres
DATABASE_URL=postgres://voyages:voyages@localhost:5432/voyages
```
→ le parser reconstruit `postgres://voyages:voyages@voyages-postgres:5432/voyages`
(`HOST_NAME` wins sur l'host de l'URL, et le DB name est extrait de l'URL).

> 💡 Le SSL est détecté automatiquement. Les hosts publics (cloud :
> Supabase, Neon, RDS, Render…) activent SSL. Les hosts locaux
> (localhost, IPs RFC1918, `.local`) le désactivent.

**Opérations SQL** :

| Opération | Description |
|---|---|
| **Execute Query** | SQL arbitraire avec param binds positionnels (`$1`/`$2` PG, `?` MySQL). Pour SELECT, retourne 1 item N8n par row. Pour INSERT/UPDATE/DELETE, retourne 1 item avec `rowCount`. |
| **List Schemas** | Retourne tous les schemas accessibles (PG) ou databases (MySQL). 1 item par schema. |
| **List Tables** | Retourne les tables d'un schema (défaut `public` pour PG, current database pour MySQL). 1 item par table avec `table_name` + `table_type`. |

**Exemple : query paramétrée PostgreSQL**

```
[Webhook]                    [Physalis: Execute SQL]
  → user_id: 42         →    Source: From Physalis
                             Project: voyages
                             Env: production
                             Tag: postgres
                             SQL Op: Execute Query
                             Query: SELECT name, email FROM users WHERE id = $1
                             Parameters: {{ $json.user_id }}
```

**Exemple : insertion MySQL avec dynamic data**

```
[Set]                        [Physalis: Execute SQL]
  → email, plan         →    Source: From Physalis
                             Project: app
                             Env: production
                             Tag: mariadb
                             SQL Op: Execute Query
                             Query: INSERT INTO subscriptions (email, plan, created_at)
                                    VALUES (?, ?, NOW())
                             Parameters: {{ $json.email }},{{ $json.plan }}
```

⚠️ **Sécurité SQL injection** : utilise TOUJOURS les param binds plutôt
que l'interpolation directe `{{ $json.x }}` dans la query. Les binds
sont passés séparément par le driver et échappés correctement. Mettre
les valeurs dynamiques dans le champ **Parameters**, pas dans **Query**.

---

### Get Credentials

Récupère secrets, services ou comptes applicatifs d'un projet, avec
filtres optionnels.

| Champ | Description |
|---|---|
| **Project** | Slug du projet (chargé dynamiquement depuis l'API) |
| **Type** | `secret` (clés/valeurs d'env) · `service` (Stripe, Firebase…) · `account` (compte applicatif) |
| **Environment** | Requis pour `secret` uniquement (ex: `production`) |
| **Tag** | Filtre par tag technique (ex: `postgres`, `stripe`). Liste chargée dynamiquement. |
| **Key** | Filtre clé exacte pour les secrets (case-sensitive) |

**Exemples de réponse :**

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
    "username": "admin@argoweb.fr",
    "password": "sk_live_...",
    "tags": ["stripe"]
  }
]

// type=account
[
  {
    "id": "ck...",
    "name": "Compte test client",
    "username": "test@example.com",
    "password": "...",
    "tags": ["staging"]
  }
]
```

### List Projects

Liste les projets accessibles au token Bearer, avec leurs environnements.
Utile pour des workflows dynamiques qui itèrent sur plusieurs projets.

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

## Permissions par type de token

| | UserToken | OrgToken | MachineToken |
|---|---|---|---|
| `getCredentials` (secret) | ✅ projets membres | ✅ scopes explicites + liste projets | ✅ projet+env unique |
| `getCredentials` (service / account) | ✅ projets membres | ✅ idem | ❌ (pas de scope service côté machine) |
| `listProjects` | ✅ tous les projets membres | ✅ projets autorisés (`PROJECTS_LIST` requis) | ✅ un seul projet |
| `executeSql` (Physalis source) | ✅ projets membres | ✅ scope `SECRETS_READ` requis | ✅ projet+env unique |
| `executeSql` (manual) | ✅ N/A — auth Bearer ignorée pour le mode manual | ✅ idem | ✅ idem |
| `sendEmail` (Physalis source) | ✅ projets membres | ✅ scope `SECRETS_READ` requis | ✅ projet+env unique |
| `sendEmail` (manual) | ✅ N/A — auth Bearer ignorée pour le mode manual | ✅ idem | ✅ idem |

> Les **OrgSecrets** (clés globales de l'org type `GITHUB_DISPATCH_TOKEN`,
> `REGISTRY_PAT`…) ne sont **jamais** accessibles via ce nœud, par design.

---

## Exemples de workflows

### Connexion PostgreSQL automatique

```
[Physalis: getCredentials]            [PostgreSQL]
  type: secret                   →    host: {{ $json.DATABASE_HOST }}
  tag: postgres                       user: {{ $json.DATABASE_USER }}
  project: voyages                    password: {{ $json.DATABASE_PASSWORD }}
  env: production
```

### Envoi d'email via Mailgun

```
[Physalis: getCredentials]            [HTTP Request]
  type: service                  →    url: https://api.mailgun.net/...
  tag: mailgun                        auth: {{ $json.username }}:{{ $json.password }}
  project: newsletter
```

---

## Sécurité

- Le token Bearer transite chiffré en TLS — utilise toujours `https://`
- Les tokens ont un préfixe identifiable (`sv_user_…`, `sv_org_…`, `sv_…`)
  pour les scans GitHub (trufflehog, gitleaks)
- Révocation instantanée depuis Physalis (le nœud cesse de fonctionner
  immédiatement)
- Chaque appel logge `INTEGRATION_CREDENTIALS_FETCH` dans l'audit Physalis

---

## Build local

```bash
npm install
npm run build       # tsc + gulp icons → dist/
npm run typecheck   # validation TS sans build
npm run lint        # eslint avec règles n8n-nodes-base
```

Pour tester dans N8n localement :

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

## Liens

- [Physalis](https://physalis.cloud)
- [Documentation Physalis](https://physalis.cloud/docs)
- [Issues](https://github.com/argo-web/physalis-n8n-nodes/issues)
- [N8n Community Nodes](https://docs.n8n.io/integrations/community-nodes/)
