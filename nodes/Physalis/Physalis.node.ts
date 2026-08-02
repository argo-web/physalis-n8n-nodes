import {
  IDataObject,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";
import {
  type DbConnection,
  type DbType,
  dbTypeFromTag,
  defaultPort,
  parseConnectionFromSecrets,
  runSqlOperation,
  type SqlOperation,
  type SslMode,
} from "./sql";
import {
  type MailgunCredentials,
  type MailgunRegion,
  parseCsvList,
  parseMailgunFromSecrets,
  sendMailgunEmail,
} from "./email";

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
        displayOptions: {
          hide: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
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
          {
            name: "Execute SQL",
            value: "executeSql",
            description:
              "Connect to a PostgreSQL / MySQL / MariaDB database (credentials from Physalis or manual) and execute a query, list schemas or list tables",
            action: "Execute SQL",
          },
          {
            name: "Send Email",
            value: "sendEmail",
            description:
              "Send an email via Mailgun (credentials from Physalis or manual). Supports HTML + text body, CC/BCC, Reply-To, tags.",
            action: "Send email",
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

      // ═══ Execute SQL operation ════════════════════════════════════
      // Cf. nodes/Physalis/sql.ts pour la convention de stockage des
      // credentials DB côté Physalis (5 Secrets : NAME, HOST, USER,
      // PASSWORD, PORT? — tous taggés avec le type de DB).

      // ─── Connection source ────────────────────────────────────────
      {
        displayName: "Credentials Source",
        name: "credentialsSource",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "From Physalis",
            value: "physalis",
            description:
              "Load DB credentials from Physalis (5 secrets tagged postgres/mysql/mariadb)",
          },
          {
            name: "Manual",
            value: "manual",
            description: "Fill connection fields directly (host, port, etc.)",
          },
        ],
        default: "physalis",
        displayOptions: {
          show: { operation: ["executeSql"] },
        },
      },

      // ── Physalis source : project + env + tag ──
      {
        displayName: "Project Name or ID",
        name: "sqlProject",
        type: "options",
        typeOptions: { loadOptionsMethod: "loadProjects" },
        required: true,
        default: "",
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["physalis"],
          },
        },
      },
      {
        displayName: "Environment",
        name: "sqlEnv",
        type: "string",
        default: "production",
        placeholder: "production",
        required: true,
        description: 'Environment name (e.g. production, staging) containing the DB secrets',
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["physalis"],
          },
        },
      },
      {
        displayName: "DB Tag",
        name: "sqlTag",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "PostgreSQL", value: "postgres" },
          { name: "MySQL", value: "mysql" },
          { name: "MariaDB", value: "mariadb" },
        ],
        default: "postgres",
        required: true,
        description:
          "Tag used to group the DB secrets in Physalis. The same tag must be set on NAME, HOST, USER, PASSWORD (and optionally PORT) for this database.",
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["physalis"],
          },
        },
      },

      // ── Manual source : type + champs séparés ──
      {
        displayName: "DB Type",
        name: "manualDbType",
        type: "options",
        // noDataExpression intentionally omitted → supports expressions from
        // incoming data (e.g. {{ $json.dbType }} from a Physalis rotation webhook).
        // Accepted values: postgres, postgresql, POSTGRESQL, mysql, MYSQL,
        // mariadb (case-insensitive, via dbTypeFromTag normalization).
        options: [
          { name: "PostgreSQL", value: "postgres" },
          { name: "MySQL", value: "mysql" },
          { name: "MariaDB", value: "mariadb" },
          {
            name: "MongoDB (Webhook Strategy Only)",
            value: "mongodb",
          },
        ],
        default: "postgres",
        required: true,
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Host",
        name: "manualHost",
        type: "string",
        default: "",
        placeholder: "db.example.com",
        required: true,
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Port",
        name: "manualPort",
        type: "number",
        default: 0,
        description:
          "TCP port. Leave at 0 to use the default (5432 for PostgreSQL, 3306 for MySQL/MariaDB).",
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "User",
        name: "manualUser",
        type: "string",
        default: "",
        required: true,
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Password",
        name: "manualPassword",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Database",
        name: "manualDatabase",
        type: "string",
        default: "",
        required: true,
        description: 'Database name to connect to',
        displayOptions: {
          show: {
            operation: ["executeSql"],
            credentialsSource: ["manual"],
          },
        },
      },

      // ─── SSL mode (common to physalis + manual sources) ──────────
      {
        displayName: "SSL Mode",
        name: "sqlSslMode",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Auto",
            value: "auto",
            description:
              "Default. SSL enabled for public hosts (cloud DBs), disabled for localhost / Docker containers / private IPs.",
          },
          {
            name: "Disable",
            value: "disable",
            description:
              "Connect without SSL. Use for local Docker / self-hosted PG without SSL configured (typical error: 'server does not support SSL connections').",
          },
          {
            name: "Require",
            value: "require",
            description:
              "Force SSL. Use when auto-detection fails for a managed DB. Self-signed certs are accepted.",
          },
        ],
        default: "auto",
        displayOptions: {
          show: { operation: ["executeSql"] },
        },
      },

      // ─── SQL operation selector ───────────────────────────────────
      {
        displayName: "SQL Operation",
        name: "sqlOperation",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Execute Query",
            value: "query",
            description:
              "Run arbitrary SQL (SELECT / INSERT / UPDATE / DELETE / DDL) with optional parameter binds",
          },
          {
            name: "List Schemas",
            value: "listSchemas",
            description: "Return all schemas accessible to the user",
          },
          {
            name: "List Tables",
            value: "listTables",
            description:
              "Return tables of a schema (default: public for PostgreSQL, current database for MySQL/MariaDB)",
          },
        ],
        default: "query",
        displayOptions: {
          show: { operation: ["executeSql"] },
        },
      },

      // ── Champs spécifiques à listTables ──
      {
        displayName: "Schema",
        name: "sqlSchema",
        type: "string",
        default: "",
        placeholder: "public",
        description:
          "Schema name. Defaults to 'public' for PostgreSQL, or the connection database for MySQL/MariaDB.",
        displayOptions: {
          show: {
            operation: ["executeSql"],
            sqlOperation: ["listTables"],
          },
        },
      },

      // ── Champs spécifiques à Execute Query ──
      {
        displayName: "Query",
        name: "sqlQuery",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        placeholder: "SELECT * FROM users WHERE id = $1",
        description:
          'SQL to execute. Use positional parameter binds: $1, $2, ... for PostgreSQL, or ? for MySQL/MariaDB. Bind values are passed via the Parameters field below.',
        displayOptions: {
          show: {
            operation: ["executeSql"],
            sqlOperation: ["query"],
          },
        },
      },
      {
        displayName: "Parameters",
        name: "sqlParams",
        type: "string",
        default: "",
        placeholder: "value1,value2,value3",
        description: 'Comma-separated values for the parameter binds in the query. For example, if the query is "SELECT * FROM users WHERE ID = $1 AND status = $2", set Parameters to "42,active". Use an n8n expression to pass dynamic values (e.g. "{{ $JSON.userId }},active").',
        displayOptions: {
          show: {
            operation: ["executeSql"],
            sqlOperation: ["query"],
          },
        },
      },

      // ═══ Send Email operation ═════════════════════════════════════
      // Cf. nodes/Physalis/email.ts pour la convention de stockage des
      // credentials Mailgun côté Physalis.

      // ─── Provider selector (V1 : Mailgun seul) ────────────────────
      {
        displayName: "Email Provider",
        name: "emailProvider",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "Mailgun",
            value: "mailgun",
            description: "Send via the Mailgun HTTP API (US or EU region)",
          },
        ],
        default: "mailgun",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },

      // ─── Credentials source (Physalis ou Manual) ──────────────────
      {
        displayName: "Credentials Source",
        name: "emailCredentialsSource",
        type: "options",
        noDataExpression: true,
        options: [
          {
            name: "From Physalis",
            value: "physalis",
            description:
              "Load Mailgun credentials (API key, domain, region) from Physalis Secrets tagged with the provider name",
          },
          {
            name: "Manual",
            value: "manual",
            description: "Fill credentials directly (API key, domain, region)",
          },
        ],
        default: "physalis",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },

      // ── Physalis source : project + env + tag ──
      {
        displayName: "Project Name or ID",
        name: "emailProject",
        type: "options",
        typeOptions: { loadOptionsMethod: "loadProjects" },
        required: true,
        default: "",
        description:
          'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["physalis"],
          },
        },
      },
      {
        displayName: "Environment",
        name: "emailEnv",
        type: "string",
        default: "production",
        placeholder: "production",
        required: true,
        description: 'Environment name (e.g. production, staging) containing the Mailgun secrets',
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["physalis"],
          },
        },
      },
      {
        displayName: "Tag",
        name: "emailTag",
        type: "string",
        default: "mailgun",
        required: true,
        description: 'Tag applied to the Mailgun secrets in Physalis (API_KEY, DOMAIN, REGION?, FROM?)',
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["physalis"],
          },
        },
      },

      // ── Manual source : champs Mailgun directs ──
      {
        displayName: "API Key",
        name: "manualMailgunApiKey",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: 'Mailgun API key (starts with \'key-\' or longer hex string)',
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Domain",
        name: "manualMailgunDomain",
        type: "string",
        default: "",
        required: true,
        placeholder: "mg.example.com",
        description: 'Sending domain configured in Mailgun (without https://)',
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["manual"],
          },
        },
      },
      {
        displayName: "Region",
        name: "manualMailgunRegion",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "US", value: "us" },
          { name: "EU", value: "eu" },
        ],
        default: "us",
        displayOptions: {
          show: {
            operation: ["sendEmail"],
            emailCredentialsSource: ["manual"],
          },
        },
      },

      // ─── Email fields (common to both sources) ────────────────────
      {
        displayName: "From",
        name: "emailFrom",
        type: "string",
        default: "",
        placeholder: "Acme <noreply@example.com>",
        description: 'Sender address. Either "Name &lt;addr@domain&gt;" or just "addr@domain". If empty, falls back to a FROM secret stored in Physalis (when using From Physalis source).',
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "To",
        name: "emailTo",
        type: "string",
        default: "",
        required: true,
        placeholder: "user@example.com, other@example.com",
        description:
          "Recipient address(es). Multiple addresses separated by commas. Each gets a separate copy.",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "Subject",
        name: "emailSubject",
        type: "string",
        default: "",
        required: true,
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "Text Body",
        name: "emailText",
        type: "string",
        typeOptions: { rows: 3 },
        default: "",
        description:
          "Plain text body of the email. At least one of Text Body / HTML Body must be filled.",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "HTML Body",
        name: "emailHtml",
        type: "string",
        typeOptions: { rows: 5 },
        default: "",
        description:
          "HTML body of the email. Will be sent alongside Text Body as a multipart alternative if both are provided.",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "CC",
        name: "emailCc",
        type: "string",
        default: "",
        placeholder: "manager@example.com, team@example.com",
        description: "Optional. Comma-separated CC addresses.",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "BCC",
        name: "emailBcc",
        type: "string",
        default: "",
        placeholder: "archive@example.com",
        description: "Optional. Comma-separated BCC addresses (hidden from recipients).",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "Reply To",
        name: "emailReplyTo",
        type: "string",
        default: "",
        placeholder: "support@example.com",
        description: "Optional. Reply-To header (where replies are sent).",
        displayOptions: {
          show: { operation: ["sendEmail"] },
        },
      },
      {
        displayName: "Tags",
        name: "emailTags",
        type: "string",
        default: "",
        placeholder: "welcome, onboarding",
        description:
          "Optional. Comma-separated Mailgun tags (max 3) for analytics / segmentation in the Mailgun dashboard.",
        displayOptions: {
          show: { operation: ["sendEmail"] },
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
    const credentialsSource = operation === "executeSql"
      ? (this.getNodeParameter("credentialsSource", 0, "physalis") as string)
      : "physalis";

    // PhysalisApi credentials are not needed for executeSql + manual mode
    // (the node connects directly to the DB using parameters from previous nodes).
    const needsPhysalisAuth = !(operation === "executeSql" && credentialsSource === "manual");
    const credentials = needsPhysalisAuth
      ? await this.getCredentials("physalisApi")
      : null;
    const vaultUrl = credentials
      ? String(credentials.vaultUrl ?? "").replace(/\/$/, "")
      : "";

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

      if (operation === "executeSql") {
        const source = this.getNodeParameter("credentialsSource", i) as
          | "physalis"
          | "manual";
        const sqlOp = this.getNodeParameter("sqlOperation", i) as SqlOperation;

        let dbConnection: DbConnection;

        if (source === "physalis") {
          // Récupère les Secrets DB depuis Physalis (project + env + tag).
          const sqlProject = this.getNodeParameter("sqlProject", i) as string;
          const sqlEnv = this.getNodeParameter("sqlEnv", i) as string;
          const sqlTag = this.getNodeParameter("sqlTag", i) as string;
          const dbType = dbTypeFromTag(sqlTag);
          if (!dbType) {
            throw new NodeOperationError(
              this.getNode(),
              `Unsupported DB tag: "${sqlTag}". Use one of: postgres, mysql, mariadb.`,
            );
          }
          const params = new URLSearchParams({
            project: sqlProject,
            env: sqlEnv,
            type: "secret",
            tag: sqlTag,
          });
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
          const secrets =
            (response as { items?: Array<{ key: string; value: string }> })
              .items ?? [];
          if (secrets.length === 0) {
            throw new NodeOperationError(
              this.getNode(),
              `No secrets found in Physalis with tag "${sqlTag}" in project ${sqlProject}/${sqlEnv}. Required keys: NAME, HOST, USER, PASSWORD (PORT optional).`,
            );
          }
          const parsed = parseConnectionFromSecrets(secrets, dbType);
          if ("error" in parsed) {
            throw new NodeOperationError(this.getNode(), parsed.error);
          }
          dbConnection = parsed;
        } else {
          // Manual : prend les champs du nœud directement.
          // Normalise via dbTypeFromTag pour accepter aussi les valeurs Physalis
          // (POSTGRESQL, MYSQL) passées par expression depuis un payload webhook.
          const dbTypeRaw = this.getNodeParameter("manualDbType", i) as string;
          const dbType = dbTypeFromTag(dbTypeRaw);
          if (!dbType) {
            throw new NodeOperationError(
              this.getNode(),
              `DB type "${dbTypeRaw}" not supported. Accepted: postgres / postgresql, mysql, mariadb. MongoDB requires the Webhook rotation strategy.`,
            );
          }
          const host = this.getNodeParameter("manualHost", i) as string;
          const portRaw = this.getNodeParameter("manualPort", i, 0) as number;
          const user = this.getNodeParameter("manualUser", i) as string;
          const password = this.getNodeParameter("manualPassword", i) as string;
          const database = this.getNodeParameter("manualDatabase", i) as string;
          dbConnection = {
            type: dbType,
            host,
            port: portRaw && portRaw > 0 ? portRaw : defaultPort(dbType),
            user,
            password,
            database,
          };
        }

        // Override du sslMode depuis le selector du nœud (commun aux 2
        // sources). "auto" = utilise la détection par hostname (cf.
        // resolveSsl dans sql.ts).
        dbConnection.sslMode = this.getNodeParameter(
          "sqlSslMode",
          i,
          "auto",
        ) as SslMode;

        // Paramètres spécifiques à l'opération SQL choisie.
        let query: string | undefined;
        let queryParams: unknown[] | undefined;
        let schema: string | undefined;

        if (sqlOp === "query") {
          query = this.getNodeParameter("sqlQuery", i) as string;
          const paramsRaw = (this.getNodeParameter(
            "sqlParams",
            i,
            "",
          ) as string).trim();
          // Parse "a,b,c" → ["a", "b", "c"]. Si vide → []. Pas d'évaluation
          // d'expressions ici — n8n résout déjà les `{{ ... }}` avant qu'on
          // reçoive la valeur.
          queryParams = paramsRaw
            ? paramsRaw.split(",").map((p) => p.trim())
            : [];
        } else if (sqlOp === "listTables") {
          const sqlSchema = (this.getNodeParameter(
            "sqlSchema",
            i,
            "",
          ) as string).trim();
          if (sqlSchema) schema = sqlSchema;
        }

        const result = await runSqlOperation({
          connection: dbConnection,
          operation: sqlOp,
          query,
          params: queryParams,
          schema,
        });

        // Pour Execute Query qui ne renvoie pas de rows (INSERT/UPDATE/DELETE),
        // on renvoie 1 item de meta (rowCount, query). Pour les autres, 1 item
        // par row.
        if (result.rows.length === 0) {
          returnData.push({
            json: {
              rowCount: result.rowCount,
              ...(result.query ? { query: result.query } : {}),
            } as IDataObject,
          });
        } else {
          for (const row of result.rows) {
            returnData.push({ json: row as IDataObject });
          }
        }
        continue;
      }

      if (operation === "sendEmail") {
        const source = this.getNodeParameter(
          "emailCredentialsSource",
          i,
        ) as "physalis" | "manual";

        let credentials: MailgunCredentials;

        if (source === "physalis") {
          const emailProject = this.getNodeParameter("emailProject", i) as string;
          const emailEnv = this.getNodeParameter("emailEnv", i) as string;
          const emailTag = this.getNodeParameter("emailTag", i) as string;
          const params = new URLSearchParams({
            project: emailProject,
            env: emailEnv,
            type: "secret",
            tag: emailTag,
          });
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
          const secrets =
            (response as { items?: Array<{ key: string; value: string }> })
              .items ?? [];
          if (secrets.length === 0) {
            throw new NodeOperationError(
              this.getNode(),
              `No secrets found in Physalis with tag "${emailTag}" in project ${emailProject}/${emailEnv}. Required keys: an API_KEY alias + DOMAIN alias (REGION + FROM optional).`,
            );
          }
          const parsed = parseMailgunFromSecrets(secrets);
          if ("error" in parsed) {
            throw new NodeOperationError(this.getNode(), parsed.error);
          }
          credentials = parsed;
        } else {
          const apiKey = this.getNodeParameter(
            "manualMailgunApiKey",
            i,
          ) as string;
          const domain = this.getNodeParameter(
            "manualMailgunDomain",
            i,
          ) as string;
          const region = this.getNodeParameter(
            "manualMailgunRegion",
            i,
          ) as MailgunRegion;
          credentials = { apiKey, domain, region };
        }

        const fromInput = (
          this.getNodeParameter("emailFrom", i, "") as string
        ).trim();
        const from = fromInput || credentials.defaultFrom;
        if (!from) {
          throw new NodeOperationError(
            this.getNode(),
            "From address is required (either fill the From field or store a FROM secret tagged with the email provider).",
          );
        }

        const toRaw = this.getNodeParameter("emailTo", i) as string;
        const to = parseCsvList(toRaw);
        if (to.length === 0) {
          throw new NodeOperationError(
            this.getNode(),
            "To address is required (at least one recipient).",
          );
        }

        const subject = this.getNodeParameter("emailSubject", i) as string;
        const text = (
          this.getNodeParameter("emailText", i, "") as string
        ) || undefined;
        const html = (
          this.getNodeParameter("emailHtml", i, "") as string
        ) || undefined;
        if (!text && !html) {
          throw new NodeOperationError(
            this.getNode(),
            "At least one of Text Body / HTML Body must be filled.",
          );
        }

        const cc = parseCsvList(
          this.getNodeParameter("emailCc", i, "") as string,
        );
        const bcc = parseCsvList(
          this.getNodeParameter("emailBcc", i, "") as string,
        );
        const replyTo = (
          this.getNodeParameter("emailReplyTo", i, "") as string
        ).trim();
        const tags = parseCsvList(
          this.getNodeParameter("emailTags", i, "") as string,
        );

        try {
          const result = await sendMailgunEmail({
            credentials,
            from,
            to,
            subject,
            text,
            html,
            cc: cc.length > 0 ? cc : undefined,
            bcc: bcc.length > 0 ? bcc : undefined,
            replyTo: replyTo || undefined,
            tags: tags.length > 0 ? tags : undefined,
          });
          returnData.push({
            json: {
              ok: true,
              provider: "mailgun",
              region: credentials.region,
              id: result.id,
              message: result.message,
              from,
              to,
              subject,
            } as IDataObject,
          });
        } catch (err) {
          throw new NodeOperationError(
            this.getNode(),
            err instanceof Error ? err.message : String(err),
          );
        }
        continue;
      }
    }

    return [returnData];
  }
}
