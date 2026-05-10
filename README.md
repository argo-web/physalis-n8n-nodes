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
