// SQL helpers pour l'opération "Execute SQL" du nœud Physalis (V0.2.0).
//
// Deux types de DB supportés en V1 : PostgreSQL (driver `pg`) et MySQL /
// MariaDB (driver `mysql2`, un seul driver pour les deux saveurs).
//
// Convention de stockage côté Physalis :
//   - 1 connexion DB = 5 Secrets dans un environnement, tous taggés avec
//     le type DB (`postgres`, `mysql` ou `mariadb`)
//   - Clés requises :
//       NAME      → label affiché + nom de la base de données
//       HOST      → hostname / IP
//       USER      → username DB
//       PASSWORD  → password DB
//   - Clé optionnelle :
//       PORT      → port TCP (default 5432 pour PG, 3306 pour MySQL/MariaDB)
//
// Mode "manual" : l'utilisateur remplit ces champs directement dans le
// nœud sans passer par Physalis.

import { Client as PgClient } from "pg";
import mysql from "mysql2/promise";

export type DbType = "postgres" | "mysql" | "mariadb";

export type SslMode = "auto" | "disable" | "require";

export type DbConnection = {
  type: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /// Mode SSL. Si "auto", on utilise needsSsl(host) pour décider.
  /// "disable" force off (utile pour les containers Docker qui n'ont pas
  /// SSL). "require" force on avec self-signed certs acceptés.
  sslMode?: SslMode;
};

/** Convention de mapping : un tag Physalis → un type de driver.
 *  Insensible à la casse. */
export function dbTypeFromTag(tag: string): DbType | null {
  const t = tag.toLowerCase().trim();
  if (t === "postgres" || t === "postgresql" || t === "pg") return "postgres";
  if (t === "mysql") return "mysql";
  if (t === "mariadb") return "mariadb";
  return null;
}

/** Port par défaut selon le type DB. */
export function defaultPort(type: DbType): number {
  if (type === "postgres") return 5432;
  return 3306; // mysql + mariadb
}

/// Candidats de clés pour chaque champ de connexion, par priorité.
/// Première clé trouvée dans la map gagne. Convention :
///   - Noms abstraits en premier (HOST, USER, PASSWORD, DATABASE)
///   - Puis variantes Docker / .env classiques (POSTGRES_*, MYSQL_*,
///     MARIADB_*, DB_*)
///   - Puis variantes alternatives (HOST_NAME, USERNAME, PWD…)
const HOST_KEYS = [
  "HOST",
  "POSTGRES_HOST",
  "MYSQL_HOST",
  "MARIADB_HOST",
  "DB_HOST",
  "HOST_NAME",
  "HOSTNAME",
];
const PORT_KEYS = [
  "PORT",
  "POSTGRES_PORT",
  "MYSQL_PORT",
  "MARIADB_PORT",
  "DB_PORT",
];
const USER_KEYS = [
  "USER",
  "POSTGRES_USER",
  "MYSQL_USER",
  "MARIADB_USER",
  "DB_USER",
  "USERNAME",
];
const PASSWORD_KEYS = [
  "PASSWORD",
  "POSTGRES_PASSWORD",
  "MYSQL_PASSWORD",
  "MARIADB_PASSWORD",
  "DB_PASSWORD",
  "PWD",
];
/// Pour la DB name (≠ display label) : on cherche le nom de la base.
const DATABASE_KEYS = [
  "DATABASE",
  "POSTGRES_DB",
  "POSTGRES_DATABASE",
  "MYSQL_DATABASE",
  "MARIADB_DATABASE",
  "DB_NAME",
  "DB_DATABASE",
  "DATABASE_NAME",
];
/// URL complète (`postgres://user:pass@host:port/dbname`) — utilisée
/// en fallback pour combler les champs manquants.
const URL_KEYS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "MYSQL_URL",
  "MARIADB_URL",
];

function findFirst(
  map: Map<string, string>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = map.get(k);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** Parse une URL de connexion DB style `postgres://user:pass@host:port/dbname`.
 *  Renvoie un objet partiel — chaque champ peut être undefined si absent. */
export function parseDbUrl(url: string): {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
} {
  try {
    const u = new URL(url);
    const port = u.port ? Number.parseInt(u.port, 10) : undefined;
    const db = u.pathname.replace(/^\//, "");
    return {
      host: u.hostname || undefined,
      port: port && Number.isInteger(port) ? port : undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: db || undefined,
    };
  } catch {
    return {};
  }
}

/** Reconstitue une DbConnection à partir d'une liste de Secrets Physalis.
 *  Convention flexible : accepte de nombreux noms de clés (cf. HOST_KEYS,
 *  PORT_KEYS, USER_KEYS, PASSWORD_KEYS, DATABASE_KEYS).
 *
 *  Fallback URL : si une clé URL_KEYS (DATABASE_URL, POSTGRES_URL…) est
 *  présente, ses champs comblent les manques. Les clés discrètes prennent
 *  toujours la priorité sur les composants extraits de l'URL (utile quand
 *  ton DATABASE_URL pointe sur localhost mais que HOST_NAME pointe sur
 *  le container hostname Docker).
 *
 *  Le parser accepte 2 shapes en entrée :
 *    - `[{ key: "NAME", value: "Voyages" }, ...]` (shape API Physalis)
 *    - `[{ NAME: "Voyages", HOST: "..." }]` (objet plat — fallback) */
export function parseConnectionFromSecrets(
  secrets: Array<unknown>,
  type: DbType,
): DbConnection | { error: string } {
  const map = new Map<string, string>();

  for (const raw of secrets) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    // Shape 1 (attendue) : { key: "NAME", value: "Voyages", ... }
    if (typeof item.key === "string") {
      const k = String(item.key).trim().toUpperCase();
      if (k) map.set(k, String(item.value ?? ""));
      continue;
    }

    // Shape 2 (fallback) : objet plat { NAME: "Voyages", HOST: "...", ... }
    for (const [rawKey, rawVal] of Object.entries(item)) {
      const k = String(rawKey).trim().toUpperCase();
      if (!k) continue;
      // Skip metadata fields qui ne sont pas des secrets DB
      if (k === "CATEGORY" || k === "TAGS" || k === "KEY" || k === "VALUE") continue;
      map.set(k, String(rawVal ?? ""));
    }
  }

  // Étape 1 : champs discrets (priorité absolue).
  let host = findFirst(map, HOST_KEYS);
  let portRaw = findFirst(map, PORT_KEYS);
  let user = findFirst(map, USER_KEYS);
  let password = findFirst(map, PASSWORD_KEYS);
  let database = findFirst(map, DATABASE_KEYS);

  // Étape 2 : URL fallback. Si une URL est présente, ses champs comblent
  // les manques sans écraser les discrets déjà trouvés.
  const urlValue = findFirst(map, URL_KEYS);
  if (urlValue) {
    const parsed = parseDbUrl(urlValue);
    host = host ?? parsed.host;
    if (!portRaw && parsed.port !== undefined) {
      portRaw = String(parsed.port);
    }
    user = user ?? parsed.user;
    password = password ?? parsed.password;
    database = database ?? parsed.database;
  }

  const missing: string[] = [];
  if (!host) missing.push("HOST");
  if (!user) missing.push("USER");
  if (!password) missing.push("PASSWORD");
  if (!database) missing.push("DATABASE");
  if (missing.length > 0) {
    const foundKeys = Array.from(map.keys()).sort();
    return {
      error:
        `Cannot build ${type} connection — missing: ${missing.join(", ")}. ` +
        `Accepted key names (case-insensitive): ` +
        `HOST=${HOST_KEYS.join("|")}, ` +
        `USER=${USER_KEYS.join("|")}, ` +
        `PASSWORD=${PASSWORD_KEYS.join("|")}, ` +
        `DATABASE=${DATABASE_KEYS.join("|")}. ` +
        `As an alternative, provide a full connection URL via one of: ${URL_KEYS.join("|")}. ` +
        `Found keys in Physalis: ${foundKeys.length > 0 ? foundKeys.join(", ") : "(none)"}.`,
    };
  }

  let port = defaultPort(type);
  if (portRaw) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: `Invalid port value: ${portRaw} (must be 1-65535).` };
    }
    port = parsed;
  }

  return {
    type,
    host: host!,
    port,
    user: user!,
    password: password!,
    database: database!,
  };
}

export type SqlOperation = "query" | "listSchemas" | "listTables";

export type SqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  /// Champ uniquement renseigné si l'opération met du SQL en clair (utile
  /// pour le debug). NE PAS exposer la valeur des params binds.
  query?: string;
};

/** Exécute une opération SQL et retourne un résultat normalisé.
 *  Connexion ouverte + fermée par appel — pas de pool persistant car N8n
 *  invoque le nœud à la demande. */
export async function runSqlOperation(opts: {
  connection: DbConnection;
  operation: SqlOperation;
  /// Pour operation="query" : le SQL brut.
  query?: string;
  /// Pour operation="query" : params binds positionnels.
  params?: unknown[];
  /// Pour operation="listTables" : nom du schema (defaut "public" pour
  /// postgres, ignore pour mysql car le concept de schema = database).
  schema?: string;
}): Promise<SqlResult> {
  if (opts.connection.type === "postgres") {
    return runPostgres(opts);
  }
  return runMysql(opts);
}

// ─── PostgreSQL ─────────────────────────────────────────────────────

async function runPostgres(opts: {
  connection: DbConnection;
  operation: SqlOperation;
  query?: string;
  params?: unknown[];
  schema?: string;
}): Promise<SqlResult> {
  const { connection, operation } = opts;
  const client = new PgClient({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    // SSL : résolu via sslMode (auto / disable / require). Cf. resolveSsl.
    ssl: resolveSsl(connection) ? { rejectUnauthorized: false } : undefined,
    // 5s timeout pour la connexion — évite de bloquer les workflows si
    // la DB est inaccessible.
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();

    if (operation === "listSchemas") {
      const res = await client.query<{ schema_name: string }>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY schema_name`,
      );
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    }

    if (operation === "listTables") {
      const schema = opts.schema || "public";
      const res = await client.query<{ table_name: string; table_type: string }>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = $1
         ORDER BY table_name`,
        [schema],
      );
      return { rows: res.rows, rowCount: res.rowCount ?? 0 };
    }

    // operation === "query"
    if (!opts.query) {
      throw new Error("Query is required for Execute Query operation.");
    }
    const res = await client.query(opts.query, opts.params ?? []);
    // pg renvoie { rows, rowCount } pour SELECT. Pour INSERT/UPDATE/DELETE,
    // rowCount = nombre de rows affectées, rows = [] sauf si RETURNING.
    return {
      rows: res.rows,
      rowCount: res.rowCount ?? 0,
      query: opts.query,
    };
  } finally {
    await client.end().catch(() => null);
  }
}

// ─── MySQL / MariaDB ────────────────────────────────────────────────

async function runMysql(opts: {
  connection: DbConnection;
  operation: SqlOperation;
  query?: string;
  params?: unknown[];
  schema?: string;
}): Promise<SqlResult> {
  const { connection, operation } = opts;
  const conn = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
    ssl: resolveSsl(connection) ? {} : undefined,
    connectTimeout: 5000,
  });

  try {
    if (operation === "listSchemas") {
      // Sur MySQL, "schema" = "database". On liste toutes les databases
      // accessibles à l'user (privilèges READ).
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT schema_name FROM information_schema.schemata
         WHERE schema_name NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
         ORDER BY schema_name`,
      );
      return {
        rows: rows as Array<Record<string, unknown>>,
        rowCount: rows.length,
      };
    }

    if (operation === "listTables") {
      // Sur MySQL le schema = database. Si l'user passe un schema, on
      // l'utilise ; sinon on prend la database de la connexion.
      const schema = opts.schema || connection.database;
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT table_name, table_type FROM information_schema.tables
         WHERE table_schema = ?
         ORDER BY table_name`,
        [schema],
      );
      return {
        rows: rows as Array<Record<string, unknown>>,
        rowCount: rows.length,
      };
    }

    // operation === "query"
    if (!opts.query) {
      throw new Error("Query is required for Execute Query operation.");
    }
    const [result] = await conn.query(opts.query, opts.params ?? []);
    // mysql2 retourne soit RowDataPacket[] pour SELECT, soit ResultSetHeader
    // pour INSERT/UPDATE/DELETE. On normalise.
    if (Array.isArray(result)) {
      return {
        rows: result as Array<Record<string, unknown>>,
        rowCount: result.length,
        query: opts.query,
      };
    }
    const header = result as mysql.ResultSetHeader;
    return {
      rows: [],
      rowCount: header.affectedRows ?? 0,
      query: opts.query,
    };
  } finally {
    await conn.end().catch(() => null);
  }
}

// ─── SSL detection ───────────────────────────────────────────────────

/** Heuristique : les hosts cloud connus exigent SSL. Les hosts internes
 *  (localhost, IPs RFC1918, .local, Docker container hostnames sans
 *  point) le désactivent. Le mode SSL du nœud peut override (auto /
 *  disable / require). */
function needsSslAuto(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return false;
  if (/^10\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (h.endsWith(".local") || h.endsWith(".internal")) return false;
  // Hostname sans point = container Docker / Kubernetes service / DNS
  // interne (ex: voyages-postgres, postgres, db, my-database).
  if (!h.includes(".")) return false;
  // Tous les autres = considérés comme publics → SSL recommandé
  return true;
}

/** Résout le besoin SSL pour une connexion en fonction du mode demandé. */
export function resolveSsl(connection: DbConnection): boolean {
  const mode = connection.sslMode ?? "auto";
  if (mode === "disable") return false;
  if (mode === "require") return true;
  return needsSslAuto(connection.host);
}
