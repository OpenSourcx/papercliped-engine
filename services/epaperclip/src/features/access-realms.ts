import { HttpError } from "../http.ts";

/**
 * Login realms, as forms. The field lists, limits, enums and defaults below come from Proxmox's API description for
 * POST/PUT /access/domains (apidoc.js, checked field by field); which fields apply to which realm type follows the
 * Proxmox admin guide. Proxmox still validates everything, so a field a given version doesn't accept comes back as its
 * own error message.
 */

export type RealmType = "pam" | "pve" | "ldap" | "ad" | "openid";
export type FieldKind = "string" | "integer" | "boolean" | "enum" | "secret";

export interface RealmField {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  max?: number;
  min?: number;
  options?: string[];
  default?: string | number | boolean;
  help?: string;
  /** Write-only: never returned by the host, blank on edit means unchanged. */
  secret?: boolean;
  group: "connection" | "login" | "sync" | "general";
  pattern?: string;
  /** Proxmox only accepts it when the realm is created. */
  createOnly?: boolean;
}

const f = (x: RealmField): RealmField => x;

const general: RealmField[] = [
  f({ name: "comment", label: "Comment", kind: "string", max: 4096, group: "general", help: "Shown on the sign-in screen when people pick this realm." }),
  f({ name: "default", label: "Default realm", kind: "boolean", group: "general", help: "Pre-selected on the sign-in screen." }),
];

const tfa = f({ name: "tfa", label: "Enforce two-factor", kind: "string", max: 128, group: "login", pattern: "^type=(oath|yubico)(,[a-z]+=[\\w.:/-]+)*$", help: "Proxmox's realm-wide second factor, for example type=oath. Leave empty to let people choose their own (Two-factor tab)." });

const directory: RealmField[] = [
  f({ name: "server1", label: "Server", kind: "string", required: true, max: 256, group: "connection", pattern: "^[A-Za-z0-9._:\\[\\]-]+$", help: "Host name or IP address." }),
  f({ name: "server2", label: "Fallback server", kind: "string", max: 256, group: "connection", pattern: "^[A-Za-z0-9._:\\[\\]-]+$" }),
  f({ name: "port", label: "Port", kind: "integer", min: 1, group: "connection", help: "Leave empty for the standard port." }),
  f({ name: "mode", label: "Encryption", kind: "enum", options: ["ldap", "ldaps", "ldap+starttls"], default: "ldap", group: "connection", help: "Use ldaps or ldap+starttls so passwords aren't sent in the clear." }),
  f({ name: "verify", label: "Verify the server certificate", kind: "boolean", default: false, group: "connection" }),
  f({ name: "capath", label: "CA certificate path", kind: "string", group: "connection", default: "/etc/ssl/certs", pattern: "^/[\\w./-]*$" }),
  f({ name: "bind_dn", label: "Bind user (DN)", kind: "string", max: 256, group: "login", help: "The account Proxmox uses to look people up." }),
  f({ name: "password", label: "Bind password", kind: "secret", secret: true, group: "login", help: "Write-only. Stored by Proxmox; leave empty to keep the current one." }),
  f({ name: "case-sensitive", label: "User names are case-sensitive", kind: "boolean", default: true, group: "login" }),
  f({ name: "check-connection", label: "Check the connection before saving", kind: "boolean", default: false, group: "connection", help: "Proxmox tries to bind to the server first and refuses the change if it can't." }),
  tfa,
  f({ name: "filter", label: "User filter", kind: "string", max: 2048, group: "sync" }),
  f({ name: "group_dn", label: "Group base DN", kind: "string", max: 256, group: "sync" }),
  f({ name: "group_filter", label: "Group filter", kind: "string", max: 2048, group: "sync" }),
  f({ name: "group_classes", label: "Group object classes", kind: "string", group: "sync", default: "groupOfNames, group, univentionGroup, ipausergroup" }),
  f({ name: "user_classes", label: "User object classes", kind: "string", group: "sync", default: "inetorgperson, posixaccount, person, user" }),
  f({ name: "sync_attributes", label: "Attribute mapping", kind: "string", group: "sync", pattern: "^\\w+=[^,]+(,\\s*\\w+=[^,]+)*$", help: "For example email=mail,firstname=givenName." }),
  f({ name: "sync-defaults-options", label: "Default sync options", kind: "string", group: "sync", pattern: "^[\\w=,;|-]+$", help: "For example scope=both,enable-new=1,remove-vanished=acl;entry." }),
];

const SCHEMAS: Record<RealmType, RealmField[]> = {
  pam: [...general, tfa],
  pve: [...general, tfa],
  ldap: [
    ...directory.slice(0, 1),
    ...directory.slice(1),
    f({ name: "base_dn", label: "Base DN", kind: "string", required: true, max: 256, group: "connection" }),
    f({ name: "user_attr", label: "User name attribute", kind: "string", required: true, max: 256, group: "login", pattern: "^\\S{2,}$", help: "For example uid." }),
    ...general,
  ],
  ad: [
    ...directory.slice(0, 1),
    ...directory.slice(1),
    f({ name: "domain", label: "Domain", kind: "string", required: true, max: 256, group: "connection", pattern: "^[A-Za-z0-9._-]+$", help: "For example corp.example.com." }),
    ...general,
  ],
  openid: [
    f({ name: "issuer-url", label: "Issuer URL", kind: "string", required: true, max: 256, group: "connection", pattern: "^https://\\S+$" }),
    f({ name: "client-id", label: "Client ID", kind: "string", required: true, max: 256, group: "connection" }),
    f({ name: "client-key", label: "Client secret", kind: "secret", secret: true, max: 256, group: "connection", help: "Write-only. Leave empty to keep the current one." }),
    f({ name: "username-claim", label: "User name claim", kind: "string", group: "login", createOnly: true, help: "Which claim becomes the Proxmox user name, for example username, subject or email." }),
    f({ name: "autocreate", label: "Create users on first sign-in", kind: "boolean", default: false, group: "login" }),
    f({ name: "scopes", label: "Scopes", kind: "string", default: "email profile", group: "login" }),
    f({ name: "prompt", label: "Prompt", kind: "string", group: "login" }),
    f({ name: "acr-values", label: "ACR values", kind: "string", group: "login" }),
    f({ name: "query-userinfo", label: "Query the userinfo endpoint", kind: "boolean", default: true, group: "login" }),
    f({ name: "groups-claim", label: "Groups claim", kind: "string", max: 256, group: "sync" }),
    f({ name: "groups-autocreate", label: "Create groups automatically", kind: "boolean", default: false, group: "sync" }),
    f({ name: "groups-overwrite", label: "Replace groups on every sign-in", kind: "boolean", default: false, group: "sync" }),
    ...general,
  ],
};

export const REALM_TYPES = Object.keys(SCHEMAS) as RealmType[];
export const REALM_ID = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/;
export const SECRET_FIELDS = new Set(["password", "client-key"]);
export const realmSchema = (): Record<RealmType, RealmField[]> => SCHEMAS;
export const canCreate = (t: string) => t === "ldap" || t === "ad" || t === "openid";
export const canSync = (t: string) => t === "ldap" || t === "ad";

/** Validates a realm form against its schema; returns the parameters to send to Proxmox (booleans as booleans). */
export function validateRealm(type: string, body: Record<string, unknown>, creating: boolean): { params: Record<string, string | number | boolean>; remove: string[] } {
  if (!REALM_TYPES.includes(type as RealmType)) throw new HttpError(400, "bad_request", "Unknown realm type");
  const fields = SCHEMAS[type as RealmType];
  const params: Record<string, string | number | boolean> = {};
  const remove: string[] = [];
  const bad = (m: string): never => {
    throw new HttpError(400, "bad_request", m);
  };
  const known = new Set(fields.map((x) => x.name));
  for (const k of Object.keys(body)) if (!known.has(k) && !["realm", "type", "clear"].includes(k)) bad(`${k} isn't a setting of ${type} realms`);
  for (const fld of fields) {
    const v = body[fld.name];
    if (v === undefined || v === null || v === "") {
      if (creating && fld.required) bad(`${fld.label} is required`);
      continue;
    }
    if (!creating && fld.createOnly) bad(`${fld.label} can only be set when the realm is created`);
    switch (fld.kind) {
      case "boolean":
        if (typeof v !== "boolean") bad(`${fld.label} must be on or off`);
        params[fld.name] = v as boolean;
        break;
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v) || v < (fld.min ?? 0) || v > 65535) bad(`${fld.label} must be a whole number from ${fld.min ?? 0} to 65535`);
        params[fld.name] = v as number;
        break;
      case "enum":
        if (typeof v !== "string" || !fld.options!.includes(v)) bad(`${fld.label} must be one of ${fld.options!.join(", ")}`);
        params[fld.name] = v as string;
        break;
      default: {
        if (typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > (fld.max ?? 4096)) bad(`${fld.label} isn't valid`);
        if (fld.pattern && !new RegExp(fld.pattern).test(v as string)) bad(`${fld.label} isn't in the expected form`);
        params[fld.name] = fld.kind === "secret" ? (v as string) : (v as string).trim();
      }
    }
  }
  // Clearing: only on edit, only known, non-required, non-secret-by-accident names.
  const clear = body.clear;
  if (clear !== undefined) {
    if (creating || !Array.isArray(clear) || clear.length > 32) bad("clear lists settings to remove, on edit only");
    for (const c of clear as unknown[]) {
      const fld = fields.find((x) => x.name === c);
      if (typeof c !== "string" || !fld || fld.required) bad("That setting can't be cleared");
      remove.push(c as string);
    }
  }
  return { params, remove };
}

export interface SyncOptions {
  scope?: "users" | "groups" | "both";
  "dry-run": boolean;
  "enable-new": boolean;
  "remove-vanished"?: string;
}

export function validateSync(body: Record<string, unknown>): SyncOptions {
  const scope = body.scope ?? "both";
  if (scope !== "users" && scope !== "groups" && scope !== "both") throw new HttpError(400, "bad_request", "Sync users, groups or both");
  for (const k of ["dryRun", "enableNew"]) if (body[k] !== undefined && typeof body[k] !== "boolean") throw new HttpError(400, "bad_request", `${k} must be true or false`);
  let rv: string | undefined;
  if (body.removeVanished !== undefined) {
    if (!Array.isArray(body.removeVanished) || !body.removeVanished.every((x) => x === "acl" || x === "properties" || x === "entry")) throw new HttpError(400, "bad_request", "removeVanished lists acl, properties and entry");
    rv = body.removeVanished.length ? (body.removeVanished as string[]).join(";") : undefined;
  }
  return { scope, "dry-run": body.dryRun !== false, "enable-new": body.enableNew !== false, ...(rv ? { "remove-vanished": rv } : {}) };
}
