import {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
} from "n8n-workflow";

/**
 * Physalis — nœud N8n pour récupérer secrets / services / comptes
 * applicatifs depuis ton vault Physalis.
 *
 * Cf. credentials/PhysalisApi.credentials.ts pour la config Bearer.
 *
 * Opérations (V1 lecture seule) :
 *   - Get Credentials : récupère les credentials d'un type (secret /
 *     service / account) avec filtres optionnels (tag, key)
 *   - List Projects   : liste les projets accessibles au token courant
 *
 * Le token Bearer (UserToken / OrgToken / MachineToken) détermine
 * automatiquement le scope d'accès — le nœud n'a pas à le gérer.
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
    inputs: ["main"],
    outputs: ["main"],
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
          show: { operation: ["getCredentials"] },
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
          show: { operation: ["getCredentials"] },
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
          returnData.push({ json: p });
        }
        continue;
      }

      if (operation === "getCredentials") {
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
          returnData.push({ json: it });
        }
        continue;
      }
    }

    return [returnData];
  }
}
