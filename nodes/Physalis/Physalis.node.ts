import {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeConnectionTypes,
} from "n8n-workflow";

/**
 * Physalis — nœud N8n pour récupérer secrets / services / comptes
 * applicatifs depuis ton vault Physalis.
 *
 * Cf. credentials/PhysalisApi.credentials.ts pour la config Bearer.
 *
 * Opérations (lecture seule) :
 *   - Get Credentials : récupère les credentials d'un type (secret /
 *     service / account) avec filtres optionnels (tag, key)
 *   - List Projects   : liste les projets accessibles au token courant
 *
 * Le token Bearer (UserToken / OrgToken / MachineToken) détermine
 * automatiquement le scope d'accès — le nœud n'a pas à le gérer.
 *
 * ⚠️ **Le paquet ne parle qu'à UN service tiers : Physalis.** C'est une règle
 * de la vérification n8n, pas une préférence — et c'est ce qui a coûté les
 * opérations `executeSql` et `sendEmail` en 1.0.0 (cf. CHANGELOG). Toute
 * opération qui appellerait une base de données, un fournisseur d'emails ou
 * quoi que ce soit d'autre que le vault referme la porte du n8n Cloud pour
 * tout le monde. Ce qu'il faut faire à la place : écrire la credential native
 * depuis le coffre (régime B) et laisser le nœud natif travailler.
 *
 * ⚠️ **Aucune dépendance à l'exécution.** `dependencies` doit rester vide :
 * c'est l'autre critère qui bloquait, et il se casse par un simple `import`.
 *
 * Convention : labels/descriptions UI en anglais (eslint-plugin-n8n-nodes-base
 * est strict sur ce point — title case pour displayName, sentence case
 * pour les actions, "Name or ID" suffix sur les options dynamiques).
 */
export class Physalis implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Physalis",
    name: "physalis",
    icon: "file:physalis.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description:
      "Fetch secrets, services and app accounts from your Physalis vault",
    defaults: {
      name: "Physalis",
    },
    // Rend le nœud attachable à un agent IA comme outil. Le motif dominant de
    // n8n aujourd'hui est « agent + outils » : un agent qui atteint des API
    // tierces sans qu'aucune clé ne soit écrite dans le workflow est
    // exactement ce que le coffre apporte, et rien d'autre ne le fait.
    usableAsTool: true,
    // ⚠️ **Deux règles de lint se contredisent ici, et il faut choisir.**
    //
    //   · `@n8n/community-nodes/node-connection-type-literal` — celui du
    //     SCANNER DE VÉRIFICATION — exige `NodeConnectionTypes.Main` ;
    //   · `n8n-nodes-base/node-class-description-inputs-wrong-regular-node` —
    //     celui, plus ancien, du plugin du projet — exige la chaîne `['main']`.
    //
    // Le premier gouverne la publication : un paquet qui ne le satisfait pas
    // est refusé à la vérification, donc invisible sur n8n Cloud. Le second
    // n'est qu'une convention interne. On satisfait celui qui décide, et on
    // fait taire l'autre ICI plutôt qu'en le retirant de la configuration —
    // pour que le conflit reste visible à la prochaine montée de version des
    // deux plugins.
    // eslint-disable-next-line n8n-nodes-base/node-class-description-inputs-wrong-regular-node
    inputs: [NodeConnectionTypes.Main],
    // eslint-disable-next-line n8n-nodes-base/node-class-description-outputs-wrong
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: "physalisApi",
        required: true,
      },
    ],
    requestDefaults: {
      baseURL: "={{$credentials.vaultUrl}}",
      headers: {
        Accept: "application/json",
      },
    },
    properties: [
      // ─── Operation selector ───────────────────────────────────────
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Get Credentials",
            value: "getCredentials",
            description:
              "Fetch secrets, services or accounts from a project (with optional filters)",
            action: "Fetch credentials",
          },
          {
            name: "List Projects",
            value: "listProjects",
            description:
              "List projects accessible to the current token (with their environments)",
            action: "List projects",
          },
        ],
        default: "getCredentials",
      },

      // ─── Source (operation: getCredentials) ───────────────────────
      // Un secret de PROJET est scopé projet × environnement : il sert à
      // déployer une application. Un secret d'ÉQUIPE (webhook, clé de veille,
      // jeton partagé) n'appartient à aucun projet — le forcer dans l'un d'eux
      // oblige à en choisir un arbitrairement.
      {
        displayName: "Source",
        name: "source",
        type: "options",
        noDataExpression: true,
        required: true,
        options: [
          {
            name: "Project",
            value: "project",
            description: "Secrets, services and accounts scoped to a project and environment",
          },
          {
            name: "Team Vault",
            value: "team_vault",
            description: "Shared team secrets that belong to no project (webhooks, watch keys)",
          },
        ],
        default: "project",
        displayOptions: {
          show: { operation: ["getCredentials"] },
        },
      },

      // ─── Collection (uniquement si source=team_vault) ─────────────
      {
        displayName: "Collection",
        name: "collection",
        type: "string",
        required: true,
        default: "",
        placeholder: "automatisation",
        description: "Slug of the team vault collection to read from",
        displayOptions: {
          show: { operation: ["getCredentials"], source: ["team_vault"] },
        },
      },
      {
        displayName: "Tag",
        name: "collectionTag",
        type: "string",
        default: "",
        placeholder: "slack",
        description: "Filter entries by tag. Leave empty to return the whole collection.",
        displayOptions: {
          show: { operation: ["getCredentials"], source: ["team_vault"] },
        },
      },
      {
        displayName: "Entry Name",
        name: "collectionKey",
        type: "string",
        default: "",
        description: "Filter by exact entry name. Leave empty to return all matching entries.",
        displayOptions: {
          show: { operation: ["getCredentials"], source: ["team_vault"] },
        },
      },

      // ─── Project selector (operation: getCredentials) ─────────────
      // displayName "Name or ID" : convention n8n pour les options dynamiques.
      {
        displayName: "Project Name or ID",
        name: "project",
        type: "options",
        typeOptions: {
          loadOptionsMethod: "loadProjects",
        },
        required: true,
        default: "",
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        displayOptions: {
          show: { operation: ["getCredentials"], source: ["project"] },
        },
      },

      // ─── Type selector ────────────────────────────────────────────
      {
        displayName: "Type",
        name: "type",
        type: "options",
        noDataExpression: true,
        required: true,
        options: [
          {
            name: "Secret",
            value: "secret",
            description: "Environment variable secret (e.g. DATABASE_URL)",
          },
          {
            name: "Service",
            value: "service",
            description:
              "External service with credentials (e.g. Stripe, Firebase)",
          },
          {
            name: "Account",
            value: "account",
            description: "App-level test or admin account",
          },
        ],
        default: "secret",
        displayOptions: {
          show: { operation: ["getCredentials"], source: ["project"] },
        },
      },

      // ─── Environment (uniquement si type=secret) ──────────────────
      {
        displayName: "Environment",
        name: "env",
        type: "string",
        default: "production",
        placeholder: "production",
        description:
          "Environment name (e.g. production, staging). Required for secrets — ignored for services and accounts.",
        displayOptions: {
          show: {
            operation: ["getCredentials"],
            source: ["project"],
            type: ["secret"],
          },
        },
      },

      // ─── Tag filter (optionnel) ───────────────────────────────────
      {
        displayName: "Tag Name or ID",
        name: "tag",
        type: "options",
        typeOptions: {
          loadOptionsMethod: "loadTags",
          loadOptionsDependsOn: ["project", "type", "env"],
        },
        default: "",
        description:
          'Filter by technical tag (e.g. postgres, stripe). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: {
          show: { operation: ["getCredentials"] },
        },
      },

      // ─── Key filter (uniquement si type=secret) ───────────────────
      {
        displayName: "Key",
        name: "key",
        type: "string",
        default: "",
        placeholder: "DATABASE_URL",
        description:
          "Filter by exact secret key (case-sensitive). Leave empty for all.",
        displayOptions: {
          show: {
            operation: ["getCredentials"],
            source: ["project"],
            type: ["secret"],
          },
        },
      },
    ],
  };

  methods = {
    loadOptions: {
      // Charge la liste des projets accessibles au token (selector dynamique).
      // Appelé par N8n quand l'utilisateur ouvre le dropdown "Project".
      async loadProjects(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("physalisApi");
        const vaultUrl = String(credentials.vaultUrl ?? "").replace(/\/$/, "");
        const response = await this.helpers.httpRequestWithAuthentication.call(
          this,
          "physalisApi",
          {
            method: "GET",
            url: `${vaultUrl}/api/integrations/projects`,
            json: true,
          },
        );
        const projects =
          (response as { projects?: Array<{ slug: string; name: string }> })
            .projects ?? [];
        return projects.map((p) => ({
          name: p.name,
          value: p.slug,
          description: `Slug: ${p.slug}`,
        }));
      },

      // Charge la liste des tags techniques d'un projet+type (selector
      // dynamique). Renvoie une option vide en tête pour permettre "no
      // filter".
      async loadTags(
        this: ILoadOptionsFunctions,
      ): Promise<INodePropertyOptions[]> {
        const project = this.getNodeParameter("project", "") as string;
        const type = this.getNodeParameter("type", "") as string;
        const env = this.getNodeParameter("env", "") as string;
        if (!project || !type) {
          return [
            {
              name: "(Select a Project and Type First)",
              value: "",
            },
          ];
        }
        if (type === "secret" && !env) {
          return [
            { name: "(Select an Environment First)", value: "" },
          ];
        }

        const credentials = await this.getCredentials("physalisApi");
        const vaultUrl = String(credentials.vaultUrl ?? "").replace(/\/$/, "");
        const params = new URLSearchParams({ project, type });
        if (type === "secret" && env) params.set("env", env);

        try {
          const response =
            await this.helpers.httpRequestWithAuthentication.call(
              this,
              "physalisApi",
              {
                method: "GET",
                url: `${vaultUrl}/api/integrations/tags?${params.toString()}`,
                json: true,
              },
            );
          const tags = (response as { tags?: string[] }).tags ?? [];
          return [
            { name: "(No Filter)", value: "" },
            ...tags.map((t) => ({ name: t, value: t })),
          ];
        } catch {
          return [{ name: "(No Filter)", value: "" }];
        }
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const operation = this.getNodeParameter("operation", 0) as string;

    // Les deux opérations parlent au vault, donc la credential est toujours
    // requise. En 0.4.x elle ne l'était pas : `executeSql` en mode « manual »
    // se connectait à une base sans passer par Physalis du tout.
    const credentials = await this.getCredentials("physalisApi");
    const vaultUrl = String(credentials.vaultUrl ?? "").replace(/\/$/, "");

    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    // L'execute est appelé une fois par "tick" mais on peut avoir N items
    // entrants (pattern N8n). On exécute l'opération pour chaque item — si
    // l'item n'apporte aucun param expression-substitué, c'est juste un
    // duplicate inutile, mais c'est l'idiome N8n attendu.
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      if (operation === "listProjects") {
        const response = await this.helpers.httpRequestWithAuthentication.call(
          this,
          "physalisApi",
          {
            method: "GET",
            url: `${vaultUrl}/api/integrations/projects`,
            json: true,
          },
        );
        const projects =
          (response as { projects?: IDataObject[] }).projects ?? [];
        for (const p of projects) {
          // ⚠️ `pairedItem` rattache chaque sortie à l'entrée qui l'a produite.
          // Sans lui, `$('Physalis').item` ne résout RIEN en aval — n8n ne sait
          // pas quel item d'entrée correspond, et l'utilisateur doit se rabattre
          // sur `.first()`, qui rend toujours l'item 0. Ça a coûté un vrai
          // défaut côté Physalis le 2026-09-06 : trois mails relevés, trois
          // alertes décrivant le premier.
          returnData.push({ json: p, pairedItem: { item: i } });
        }
        continue;
      }

      if (operation === "getCredentials") {
        // ⚠️ Défaut "project" et non une lecture nue : les workflows créés avec
        // les versions ≤ 0.3.x n'ont pas ce paramètre. Sans ce défaut, ils
        // casseraient à la première exécution après mise à jour du nœud.
        const source = this.getNodeParameter("source", i, "project") as
          | "project"
          | "team_vault";

        if (source === "team_vault") {
          const collection = this.getNodeParameter("collection", i) as string;
          const collectionTag =
            (this.getNodeParameter("collectionTag", i, "") as string) || "";
          const collectionKey =
            (this.getNodeParameter("collectionKey", i, "") as string) || "";

          const params = new URLSearchParams({
            type: "team_vault",
            collection,
          });
          if (collectionTag) params.set("tag", collectionTag);
          if (collectionKey) params.set("key", collectionKey);

          const response =
            await this.helpers.httpRequestWithAuthentication.call(
              this,
              "physalisApi",
              {
                method: "GET",
                url: `${vaultUrl}/api/integrations/credentials?${params.toString()}`,
                json: true,
              },
            );
          const fetched = (response as { items?: IDataObject[] }).items ?? [];
          for (const it of fetched) {
            returnData.push({ json: it, pairedItem: { item: i } });
          }
          continue;
        }

        const project = this.getNodeParameter("project", i) as string;
        const type = this.getNodeParameter("type", i) as
          | "secret"
          | "service"
          | "account";
        const tag = (this.getNodeParameter("tag", i, "") as string) || "";
        const env =
          type === "secret"
            ? (this.getNodeParameter("env", i, "") as string) || ""
            : "";
        const key =
          type === "secret"
            ? (this.getNodeParameter("key", i, "") as string) || ""
            : "";

        const params = new URLSearchParams({ project, type });
        if (env) params.set("env", env);
        if (tag) params.set("tag", tag);
        if (key) params.set("key", key);

        const response = await this.helpers.httpRequestWithAuthentication.call(
          this,
          "physalisApi",
          {
            method: "GET",
            url: `${vaultUrl}/api/integrations/credentials?${params.toString()}`,
            json: true,
          },
        );
        const fetchedItems =
          (response as { items?: IDataObject[] }).items ?? [];
        for (const it of fetchedItems) {
          returnData.push({ json: it, pairedItem: { item: i } });
        }
        continue;
      }
    }

    return [returnData];
  }
}
