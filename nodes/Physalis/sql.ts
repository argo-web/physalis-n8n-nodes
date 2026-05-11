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

export type DbConnection = {
  type: DbType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
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

/** Reconstitue une DbConnection à partir d'une liste de Secrets Physalis.
 *  La liste vient de GET /api/integrations/credentials?type=secret&tag=<type>.
 *  Renvoie un message d'erreur explicite si une clé requise manque.
 *
 *  Defensive parsing :
 *    - Accepte soit la shape attendue `[{key, value}, ...]`
 *    - Soit un fallback objet plat `[{NAME, HOST, USER, ...}]` (au cas où
 *      un intermédiaire transforme la réponse)
 *    - Normalise key (trim + uppercase) pour éviter les pièges
 *      whitespace / casse
 *    - Erreur explicite avec la liste des clés réellement trouvées pour
 *      aider au diagnostic
 */
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

  const name = map.get("NAME");
  const host = map.get("HOST");
  const user = map.get("USER");
  const password = map.get("PASSWORD");
  const portRaw = map.get("PORT");

  const missing: string[] = [];
  if (!name) missing.push("NAME");
  if (!host) missing.push("HOST");
  if (!user) missing.push("USER");
  if (!password) missing.push("PASSWORD");
  if (missing.length > 0) {
    const foundKeys = Array.from(map.keys()).sort();
    return {
      error: `Missing required Physalis secret(s) for ${type}: ${missing.join(", ")}. Required keys: NAME, HOST, USER, PASSWORD (PORT is optional, defaults to ${defaultPort(type)}). Found keys: ${foundKeys.length > 0 ? foundKeys.join(", ") : "(none)"}.`,
    };
  }

  let port = defaultPort(type);
  if (portRaw) {
    const parsed = Number.parseInt(portRaw, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { error: `Invalid PORT value: ${portRaw} (must be 1-65535).` };
    }
    port = parsed;
  }

  return {
    type,
    host: host!,
    port,
    user: user!,
    password: password!,
    database: name!,
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
    // SSL : auto-détection. Si l'host est un .neon.tech, .supabase.co,
    // .amazonaws.com (RDS), .render.com → SSL obligatoire. Pour les
    // hosts internes (localhost, IPs privées), SSL désactivé.
    ssl: needsSsl(connection.host)
      ? { rejectUnauthorized: false }
      : undefined,
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
    ssl: needsSsl(connection.host) ? {} : undefined,
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
 *  (localhost, IPs RFC1918, .local) le désactivent. Le user peut override
 *  via le champ SSL du nœud (option future). */
function needsSsl(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return false;
  if (/^10\./.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/^192\.168\./.test(h)) return false;
  if (h.endsWith(".local") || h.endsWith(".internal")) return false;
  // Tous les autres = considérés comme publics → SSL recommandé
  return true;
}
