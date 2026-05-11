// Email helpers pour l'opération "Send Email" du nœud Physalis (V0.3.0).
//
// V1 : provider Mailgun uniquement (US + EU). Pas de dépendance SDK —
// on tape directement l'API REST Mailgun via fetch (POST form-data).
// Cf. https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/
//
// Convention de stockage côté Physalis : Secrets dans un env, tous
// taggés `mailgun`. Le parser accepte plusieurs noms par champ —
// même pattern que sql.ts (mailgun-specific en priorité, fallback
// génériques).

export type EmailProvider = "mailgun";
export type MailgunRegion = "us" | "eu";

export type MailgunCredentials = {
  apiKey: string;
  domain: string;
  region: MailgunRegion;
  /// From par défaut récupéré des secrets (override possible dans le nœud).
  defaultFrom?: string;
};

const API_KEY_KEYS = [
  "MAILGUN_API_KEY",
  "MAILGUN_KEY",
  "MAILGUN_SECRET_KEY",
  "API_KEY",
  "EMAIL_API_KEY",
];
const DOMAIN_KEYS = [
  "MAILGUN_DOMAIN",
  "MAIL_DOMAIN",
  "EMAIL_DOMAIN",
  "DOMAIN",
  "SENDING_DOMAIN",
];
const REGION_KEYS = [
  "MAILGUN_REGION",
  "EMAIL_REGION",
  "REGION",
];
/// FROM par défaut (peut être override par le champ "From" du nœud).
const FROM_KEYS = [
  "MAILGUN_FROM",
  "EMAIL_FROM",
  "FROM",
  "FROM_EMAIL",
  "SENDER",
  "DEFAULT_FROM",
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

/** Reconstitue les credentials Mailgun depuis une liste de Secrets
 *  Physalis (typiquement retournée par GET /api/integrations/credentials
 *  avec type=secret&tag=mailgun).
 *
 *  Accepte 2 shapes en entrée :
 *    - `[{ key: "MAILGUN_API_KEY", value: "..." }, ...]` (shape API)
 *    - `[{ MAILGUN_API_KEY: "...", ... }]` (objet plat — fallback) */
export function parseMailgunFromSecrets(
  secrets: Array<unknown>,
): MailgunCredentials | { error: string } {
  const map = new Map<string, string>();

  for (const raw of secrets) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.key === "string") {
      const k = String(item.key).trim().toUpperCase();
      if (k) map.set(k, String(item.value ?? ""));
      continue;
    }
    for (const [rawKey, rawVal] of Object.entries(item)) {
      const k = String(rawKey).trim().toUpperCase();
      if (!k) continue;
      if (k === "CATEGORY" || k === "TAGS" || k === "KEY" || k === "VALUE") continue;
      map.set(k, String(rawVal ?? ""));
    }
  }

  const apiKey = findFirst(map, API_KEY_KEYS);
  const domain = findFirst(map, DOMAIN_KEYS);
  const regionRaw = findFirst(map, REGION_KEYS);
  const defaultFrom = findFirst(map, FROM_KEYS);

  const missing: string[] = [];
  if (!apiKey) missing.push("API_KEY");
  if (!domain) missing.push("DOMAIN");
  if (missing.length > 0) {
    const foundKeys = Array.from(map.keys()).sort();
    return {
      error:
        `Cannot build Mailgun credentials — missing: ${missing.join(", ")}. ` +
        `Accepted key names (case-insensitive): ` +
        `API_KEY=${API_KEY_KEYS.join("|")}, ` +
        `DOMAIN=${DOMAIN_KEYS.join("|")}. ` +
        `Optional: REGION=${REGION_KEYS.join("|")} (default us), ` +
        `FROM=${FROM_KEYS.join("|")}. ` +
        `Found keys in Physalis: ${foundKeys.length > 0 ? foundKeys.join(", ") : "(none)"}.`,
    };
  }

  let region: MailgunRegion = "us";
  if (regionRaw) {
    const r = regionRaw.trim().toLowerCase();
    if (r === "eu" || r === "europe") region = "eu";
    else if (r === "us" || r === "united-states") region = "us";
    else {
      return {
        error: `Invalid REGION value: "${regionRaw}". Use "us" or "eu".`,
      };
    }
  }

  return {
    apiKey: apiKey!,
    domain: domain!,
    region,
    defaultFrom: defaultFrom || undefined,
  };
}

export type SendEmailInput = {
  /// Mailgun API endpoint à utiliser. Calculé depuis la région.
  credentials: MailgunCredentials;
  /// Sender (override defaultFrom si fourni). Format : "Name <addr@dom>" ou "addr@dom".
  from: string;
  /// Destinataires. Mailgun accepte plusieurs adresses séparées par virgule.
  to: string[];
  subject: string;
  /// Au moins un des deux doit être non vide.
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  /// Tags Mailgun pour analytics (1 à 3 recommandé).
  tags?: string[];
};

export type SendEmailResult = {
  id: string;
  message: string;
};

/** Envoie un email via l'API Mailgun. Renvoie { id, message } en cas de
 *  succès. Throw en cas d'erreur (status != 200) avec le message d'erreur
 *  retourné par Mailgun. */
export async function sendMailgunEmail(
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const { credentials } = input;
  const baseUrl =
    credentials.region === "eu"
      ? "https://api.eu.mailgun.net"
      : "https://api.mailgun.net";
  const url = `${baseUrl}/v3/${encodeURIComponent(credentials.domain)}/messages`;

  // Auth Basic : user="api", password=apiKey.
  const auth = Buffer.from(`api:${credentials.apiKey}`).toString("base64");

  // Form-encoded body. Mailgun accepte plusieurs valeurs pour "to" / "cc"
  // / "bcc" / "o:tag" via plusieurs paires clé=valeur (= URLSearchParams
  // append).
  const params = new URLSearchParams();
  params.set("from", input.from);
  for (const t of input.to) params.append("to", t);
  params.set("subject", input.subject);
  if (input.text) params.set("text", input.text);
  if (input.html) params.set("html", input.html);
  for (const cc of input.cc ?? []) params.append("cc", cc);
  for (const bcc of input.bcc ?? []) params.append("bcc", bcc);
  if (input.replyTo) params.set("h:Reply-To", input.replyTo);
  for (const tag of input.tags ?? []) params.append("o:tag", tag);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const body = await res.text();
  if (!res.ok) {
    // Mailgun renvoie souvent un JSON avec { message: "..." } sur les erreurs.
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      // Pas du JSON — on garde le texte brut.
    }
    throw new Error(`Mailgun ${res.status}: ${detail}`);
  }

  try {
    const parsed = JSON.parse(body) as { id?: string; message?: string };
    return {
      id: parsed.id ?? "",
      message: parsed.message ?? "Queued",
    };
  } catch {
    return { id: "", message: body };
  }
}

/** Parse "a, b, c" → ["a", "b", "c"] avec trim + filter vide. Format
 *  accepté par les champs To / Cc / Bcc / Tags du nœud n8n. */
export function parseCsvList(input: string): string[] {
  if (!input || !input.trim()) return [];
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
