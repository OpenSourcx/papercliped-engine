/**
 * Driver configuration: parsing, normalising and validating what an operator
 * saved on a Paperclip environment.
 *
 * Paperclip hands every hook the raw `config` object. Saved secrets
 * (`format: "secret-ref"`) arrive as a secret id at validation time and as the
 * resolved value at run time, so validation skips content checks for values
 * that look like a secret id.
 */

export const DEFAULT_API_URL = "https://127.0.0.1:8006";
export const DEFAULT_BRIDGE = "vmbr0";
export const DEFAULT_SSH_USER = "root";
export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_NAME_PREFIX = "epaperclip";
export const DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_CORES = 2;
export const DEFAULT_MEMORY_MB = 2048;
export const DEFAULT_DISK_GB = 16;

export interface ProxmoxDriverConfig {
  apiUrl: string;
  node: string | null;
  apiTokenId: string | null;
  apiTokenSecret: string | null;
  /** apiTokenId and the token id inside a full-form apiTokenSecret disagree. */
  apiTokenIdConflict: boolean;
  caCert: string | null;
  allowInsecureTls: boolean;
  /** Either a CT template vmid (clone) or a `storage:vztmpl/...` volid (create). */
  template: string | null;
  pool: string | null;
  storage: string | null;
  bridge: string;
  cores: number;
  memoryMb: number;
  /** Root disk size. For clones it is a minimum: the disk is grown, never shrunk. */
  diskGb: number | null;
  unprivileged: boolean;
  allowPrivileged: boolean;
  sshPrivateKey: string | null;
  sshUser: string;
  sshPort: number;
  namePrefix: string;
  reuseLease: boolean;
  timeoutMs: number;
}

export type TemplateRef =
  | { kind: "vmid"; vmid: number }
  | { kind: "volid"; volid: string; storage: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// `user@realm!tokenname`, as Proxmox prints it when the token is created.
const TOKEN_ID_RE = /^[A-Za-z0-9._@-]+@[A-Za-z0-9._-]+![A-Za-z][A-Za-z0-9._-]*$/;
const NODE_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const POOL_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
const STORAGE_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const BRIDGE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,14}$/;
const VOLID_RE = /^([A-Za-z][A-Za-z0-9._-]*):(vztmpl|backup)\/[A-Za-z0-9._+-]+$/;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function isSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Keeps the value verbatim apart from surrounding whitespace (PEM blocks keep their inner newlines). */
function block(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function int(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

function optionalInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

/** A DNS-label-safe prefix for container hostnames. */
export function normalizeNamePrefix(value: string | null): string {
  const normalized = (value ?? DEFAULT_NAME_PREFIX)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return normalized.length > 0 ? normalized : DEFAULT_NAME_PREFIX;
}

export function normalizeApiUrl(value: string | null): string {
  const raw = value ?? DEFAULT_API_URL;
  try {
    const url = new URL(raw);
    // Accept a pasted `.../api2/json` and keep only the origin; the client adds the path.
    return url.origin;
  } catch {
    return raw;
  }
}

/**
 * Proxmox token secrets are UUIDs, and Paperclip reads a bare UUID in a
 * `secret-ref` field as the id of a saved secret. So the secret can also be
 * pasted in the full form Proxmox prints, `user@realm!name=<secret>` (with or
 * without a leading `PVEAPIToken=`), which Paperclip then stores as a new
 * secret. This splits that form; anything else is returned unchanged.
 */
export function splitApiToken(value: string | null): { tokenId: string | null; secret: string | null } {
  if (!value) return { tokenId: null, secret: null };
  const match = /^(?:PVEAPIToken=)?([^\s=!]+@[^\s=!]+![^\s=]+)=(\S+)$/.exec(value);
  return match ? { tokenId: match[1]!, secret: match[2]! } : { tokenId: null, secret: value };
}

export function parseConfig(raw: Record<string, unknown>): ProxmoxDriverConfig {
  const configuredTokenId = str(raw.apiTokenId);
  const token = splitApiToken(str(raw.apiTokenSecret));
  return {
    apiUrl: normalizeApiUrl(str(raw.apiUrl)),
    node: str(raw.node),
    apiTokenId: configuredTokenId ?? token.tokenId,
    apiTokenSecret: token.secret,
    apiTokenIdConflict: Boolean(configuredTokenId && token.tokenId && configuredTokenId !== token.tokenId),
    caCert: block(raw.caCert),
    allowInsecureTls: bool(raw.allowInsecureTls, false),
    template: str(raw.template),
    pool: str(raw.pool),
    storage: str(raw.storage),
    bridge: str(raw.bridge) ?? DEFAULT_BRIDGE,
    cores: int(raw.cores, DEFAULT_CORES),
    memoryMb: int(raw.memoryMb, DEFAULT_MEMORY_MB),
    diskGb: optionalInt(raw.diskGb),
    unprivileged: bool(raw.unprivileged, true),
    allowPrivileged: bool(raw.allowPrivileged, false),
    sshPrivateKey: block(raw.sshPrivateKey),
    sshUser: str(raw.sshUser) ?? DEFAULT_SSH_USER,
    sshPort: int(raw.sshPort, DEFAULT_SSH_PORT),
    namePrefix: normalizeNamePrefix(str(raw.namePrefix)),
    reuseLease: bool(raw.reuseLease, false),
    timeoutMs: int(raw.timeoutMs, DEFAULT_TIMEOUT_MS),
  };
}

export function parseTemplateRef(value: string | null): TemplateRef | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const vmid = Number(value);
    return vmid >= 100 && vmid <= 999_999_999 ? { kind: "vmid", vmid } : null;
  }
  const match = VOLID_RE.exec(value);
  return match ? { kind: "volid", volid: value, storage: match[1]! } : null;
}

/** Shape checks that need no network. Returns errors and warnings for the operator. */
export function checkConfig(config: ProxmoxDriverConfig): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  let apiUrl: URL | null = null;
  try {
    apiUrl = new URL(config.apiUrl);
  } catch {
    errors.push("apiUrl must be a URL such as https://127.0.0.1:8006.");
  }
  if (apiUrl && apiUrl.protocol !== "https:") {
    errors.push("apiUrl must use https: the API token is sent on every request.");
  }

  if (!config.node) errors.push("node is required: the Proxmox node that runs the containers (e.g. pve).");
  else if (!NODE_RE.test(config.node)) errors.push("node must be a Proxmox node name (letters, digits and dashes).");

  if (!config.apiTokenId) errors.push("apiTokenId is required, e.g. epaperclip-engine@pve!sandbox.");
  else if (!TOKEN_ID_RE.test(config.apiTokenId)) {
    errors.push("apiTokenId must look like user@realm!tokenname, e.g. epaperclip-engine@pve!sandbox.");
  }
  if (!config.apiTokenSecret) errors.push("apiTokenSecret is required.");
  if (config.apiTokenIdConflict) {
    errors.push("apiTokenSecret names a different token than apiTokenId. Use the same token in both, or leave apiTokenId empty.");
  }

  if (config.caCert && !isSecretRef(config.caCert.trim())) {
    const caError = validateCaCert(config.caCert);
    if (caError) errors.push(caError);
  }
  if (config.allowInsecureTls) {
    if (config.caCert) {
      warnings.push("allowInsecureTls is ignored because caCert is set; the certificate is verified against it.");
    } else {
      warnings.push(
        "allowInsecureTls is on: the Proxmox certificate is not verified and the API token can be intercepted. Paste the cluster CA (/etc/pve/pve-root-ca.pem) into caCert instead.",
      );
    }
  }

  const template = parseTemplateRef(config.template);
  if (!config.template) {
    errors.push("template is required: the vmid of an LXC template to clone (e.g. 9000), or a CT template volid (e.g. local:vztmpl/debian-12-standard_12.12-1_amd64.tar.zst).");
  } else if (!template) {
    errors.push("template must be a CT template vmid (100 or more) or a volid like local:vztmpl/<file>.tar.zst.");
  }

  if (!config.pool) {
    errors.push("pool is required: containers are created in this Proxmox pool, and the API token should only have rights on it.");
  } else if (!POOL_RE.test(config.pool)) {
    errors.push("pool must be a Proxmox pool id.");
  }

  if (config.storage && !STORAGE_RE.test(config.storage)) errors.push("storage must be a Proxmox storage id (e.g. local-lvm).");
  if (template?.kind === "volid" && !config.storage) {
    errors.push("storage is required when template is a volid: it is where the new container's root disk is created.");
  }
  if (!BRIDGE_RE.test(config.bridge)) errors.push("bridge must be a Linux bridge name such as vmbr0.");

  if (!Number.isInteger(config.cores) || config.cores < 1 || config.cores > 512) errors.push("cores must be between 1 and 512.");
  if (!Number.isInteger(config.memoryMb) || config.memoryMb < 256 || config.memoryMb > 4_194_304) {
    errors.push("memoryMb must be between 256 and 4194304.");
  }
  if (config.diskGb != null && (!Number.isInteger(config.diskGb) || config.diskGb < 1 || config.diskGb > 131_072)) {
    errors.push("diskGb must be between 1 and 131072.");
  }

  if (!config.unprivileged && !config.allowPrivileged) {
    errors.push(
      "Privileged containers are refused: root in a privileged container is root on the Proxmox host. Keep unprivileged on, or set allowPrivileged if you really accept that risk.",
    );
  } else if (!config.unprivileged) {
    warnings.push("Privileged containers are allowed: agent code that escapes the container is root on the Proxmox host.");
  }

  if (!config.sshPrivateKey) {
    errors.push("sshPrivateKey is required: the engine runs every command in the container over SSH with this key.");
  } else if (!isSecretRef(config.sshPrivateKey.trim())) {
    const keyError = validateSshPrivateKey(config.sshPrivateKey);
    if (keyError) errors.push(keyError);
  }
  if (!SSH_USER_RE.test(config.sshUser)) errors.push("sshUser must be a Linux user name.");
  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65_535) errors.push("sshPort must be between 1 and 65535.");

  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 86_400_000) {
    errors.push("timeoutMs must be between 1000 and 86400000.");
  }

  if (template?.kind === "vmid") {
    warnings.push(
      "Cloned containers keep the template's authorized SSH keys: the template must already trust the public half of sshPrivateKey (build-template.sh --ssh-public-key).",
    );
  }
  warnings.push(
    "The engine host must reach the containers' addresses on the bridge over SSH. The first connection to each new container records its host key (trust on first use).",
  );
  if (config.reuseLease) {
    warnings.push("reuseLease keeps containers running between runs, so they keep using memory until Paperclip destroys them.");
  }

  return { errors, warnings };
}

export function validateCaCert(pem: string): string | null {
  const trimmed = pem.trim();
  const blocks = trimmed.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length === 0) {
    return "caCert must be a PEM certificate starting with -----BEGIN CERTIFICATE----- (on the Proxmox host: /etc/pve/pve-root-ca.pem).";
  }
  if (/PRIVATE KEY-----/.test(trimmed)) {
    return "caCert contains a private key. Paste only the CA certificate (/etc/pve/pve-root-ca.pem), never a key.";
  }
  for (const pemBlock of blocks) {
    const body = pemBlock
      .replace(/-----(BEGIN|END) CERTIFICATE-----/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (body.length === 0 || body.some((line) => !/^[A-Za-z0-9+/=]+$/.test(line))) {
      return "caCert has a damaged certificate body (non-base64 characters). Copy the whole file again.";
    }
  }
  return null;
}

/**
 * Catches the usual paste mistakes (public key, PuTTY file, truncated PEM)
 * before a container is created. The same checks as Paperclip's exe.dev
 * provider, plus a refusal of passphrase-protected keys, which cannot work with
 * ssh's BatchMode.
 */
export function validateSshPrivateKey(rawKey: string): string | null {
  const trimmed = rawKey.trim();
  if (!trimmed) return null;

  if (/^PuTTY-User-Key-File-\d/m.test(trimmed)) {
    return "sshPrivateKey looks like a PuTTY .ppk file. Convert it to OpenSSH format (PuTTYgen → Conversions → Export OpenSSH key) and paste the result.";
  }
  if (/^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-[a-z0-9-]+|sk-(?:ssh-ed25519|ecdsa-sha2-[a-z0-9-]+)@openssh\.com)\s+\S/.test(trimmed)) {
    return "sshPrivateKey looks like a PUBLIC key. Paste the matching private key (the file without the .pub extension).";
  }
  const headerMatch = trimmed.match(/^-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/m);
  if (!headerMatch) {
    return "sshPrivateKey must be a PEM private key starting with a line like '-----BEGIN OPENSSH PRIVATE KEY-----'.";
  }
  const footerMatch = trimmed.match(/^-----END ([A-Z0-9 ]*)PRIVATE KEY-----\s*$/m);
  if (!footerMatch) {
    return "sshPrivateKey is missing its '-----END … PRIVATE KEY-----' footer. Copy the whole file, including the last line.";
  }
  const headerLabel = headerMatch[1]!.trim();
  const footerLabel = footerMatch[1]!.trim();
  if (headerLabel !== footerLabel) {
    return `sshPrivateKey header/footer mismatch (BEGIN ${headerLabel || "(none)"} vs END ${footerLabel || "(none)"}). The file is truncated or two keys are pasted together.`;
  }
  if (headerLabel === "ENCRYPTED" || /^Proc-Type:\s*4,ENCRYPTED/m.test(trimmed)) {
    return "sshPrivateKey is protected by a passphrase. The engine connects non-interactively, so use a key without one (ssh-keygen -t ed25519 -N '').";
  }
  const headerLineEnd = trimmed.indexOf("\n", headerMatch.index ?? 0);
  const footerStart = trimmed.lastIndexOf(footerMatch[0]);
  if (headerLineEnd < 0 || footerStart <= headerLineEnd) {
    return "sshPrivateKey appears to be empty between its BEGIN and END markers.";
  }
  const bodyLines = trimmed
    .slice(headerLineEnd + 1, footerStart)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (bodyLines.length === 0) return "sshPrivateKey appears to be empty between its BEGIN and END markers.";
  const base64Line = /^[A-Za-z0-9+/=]+$/;
  const pemHeaderLine = /^[A-Za-z][A-Za-z0-9-]*:\s.+$/;
  for (const line of bodyLines) {
    if (!base64Line.test(line) && !pemHeaderLine.test(line)) {
      return "sshPrivateKey body contains non-base64 characters. The key may have been damaged by line-wrapping or copy-paste.";
    }
  }
  return null;
}
