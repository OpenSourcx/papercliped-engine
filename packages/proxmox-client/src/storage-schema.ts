/**
 * What Proxmox's "Add storage" dialog offers, as data: one definition per storage type with the fields that apply to
 * it. The host service validates against it and the console renders its forms from it, so the two can never disagree.
 *
 * Every key, enum and range below was checked against the Proxmox VE API viewer (POST /storage, PUT /storage/{storage},
 * /nodes/{node}/scan/*). The API lists all parameters in one flat set, so which type a parameter belongs to comes from
 * Proxmox's storage plugins; only parameters present in POST /storage appear here. GlusterFS is gone from the API in
 * current releases and is not offered.
 *
 * Pure data and functions: no Node imports, so the browser can use it.
 */

export const CONTENT_TYPES = ["images", "rootdir", "vztmpl", "iso", "backup", "snippets", "import"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const CONTENT_LABELS: Record<ContentType, { label: string; help: string }> = {
  images: { label: "Virtual machine disks", help: "Disk images for virtual machines." },
  rootdir: { label: "Container volumes", help: "Root and mount point volumes for containers." },
  vztmpl: { label: "Container templates", help: "Templates new containers are created from." },
  iso: { label: "ISO images", help: "Installer images virtual machines boot from." },
  backup: { label: "Backups", help: "Backup archives made by backup jobs." },
  snippets: { label: "Snippets", help: "Hook scripts and cloud-init files." },
  import: { label: "Import", help: "Disk images to import into virtual machines." },
};

export type FieldKind = "string" | "int" | "bool" | "enum" | "secret" | "multiline";

export interface StorageField {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  required?: boolean;
  /** Proxmox fixes this when the storage is created; the edit form shows it but can't change it. */
  createOnly?: boolean;
  /** Write-only: never returned by the host service. Leaving it empty on edit keeps the stored value. */
  secret?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  placeholder?: string;
  /** Tested against the whole value. */
  pattern?: string;
  patternMessage?: string;
  /** Hidden behind "More options". */
  advanced?: boolean;
  /** Proxmox can list candidates for this field from the device (see ScanKind). */
  scan?: ScanKind;
}

export type ScanKind = "nfs" | "cifs" | "pbs" | "iscsi" | "lvm" | "lvmthin" | "zfs";

export interface StorageTypeDef {
  type: StorageType;
  label: string;
  summary: string;
  fields: StorageField[];
  /** Content types this type can hold; the first ones are preselected when adding. */
  contents: ContentType[];
  defaultContent: ContentType[];
  /** Shared by nature: every node sees the same data, so the flag isn't offered. */
  alwaysShared?: boolean;
  /** Whether the "shared" flag makes sense (a local directory on shared hardware, for instance). */
  canShare?: boolean;
  /** Offers retention settings. */
  prune?: boolean;
  /** Offers bandwidth limits. */
  bwlimit?: boolean;
}

export const STORAGE_TYPES = ["dir", "nfs", "cifs", "pbs", "lvm", "lvmthin", "zfspool", "iscsi", "iscsidirect", "cephfs", "rbd", "btrfs", "zfs", "esxi"] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];

export const STORAGE_ID_RE = /^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/;
export const STORAGE_ID_HINT = "2 to 40 characters: lowercase letters, digits, - _ and . , starting with a letter.";
const PATH_RE = "^/[^\\x00-\\x1f,\"'`\\\\]*$";
const SERVER_RE = "^[A-Za-z0-9]([A-Za-z0-9.:-]{0,250})$|^\\[[0-9A-Fa-f:.]+\\]$";
const NAME_RE = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const FILE_CONTENT = ["images", "rootdir", "vztmpl", "iso", "backup", "snippets", "import"] as ContentType[];

const F = {
  path: (over: Partial<StorageField> = {}): StorageField => ({ key: "path", label: "Directory", kind: "string", required: true, createOnly: true, placeholder: "/mnt/data", pattern: PATH_RE, patternMessage: "Use an absolute path such as /mnt/data.", help: "Where on this device the files are kept.", ...over }),
  server: (over: Partial<StorageField> = {}): StorageField => ({ key: "server", label: "Server", kind: "string", required: true, createOnly: true, placeholder: "192.168.1.20 or nas.lan", pattern: SERVER_RE, patternMessage: "Use a host name or IP address.", ...over }),
  username: (over: Partial<StorageField> = {}): StorageField => ({ key: "username", label: "Username", kind: "string", pattern: "^[^\\x00-\\x1f,]{1,128}$", patternMessage: "Usernames can't contain commas or control characters.", ...over }),
  password: (over: Partial<StorageField> = {}): StorageField => ({ key: "password", label: "Password", kind: "secret", secret: true, help: "Stored by Proxmox. It is never shown again; leave it empty when editing to keep the current one.", ...over }),
  mountOptions: (): StorageField => ({ key: "options", label: "Mount options", kind: "string", advanced: true, placeholder: "vers=4.2", pattern: "^[\\w=.,:/-]{1,256}$", patternMessage: "Use mount options such as vers=4.2,noatime.", help: "Passed to the mount command, for example vers=4.2." }),
  format: (): StorageField => ({ key: "format", label: "Default disk format", kind: "enum", advanced: true, options: [{ value: "raw", label: "Raw (fastest)" }, { value: "qcow2", label: "QCOW2 (snapshots, thin)" }, { value: "vmdk", label: "VMDK" }], help: "Used for new virtual machine disks unless the disk says otherwise." }),
  preallocation: (): StorageField => ({ key: "preallocation", label: "Preallocation", kind: "enum", advanced: true, options: [{ value: "off", label: "Off" }, { value: "metadata", label: "Metadata (default)" }, { value: "falloc", label: "Fast allocate" }, { value: "full", label: "Full" }], help: "How much space new raw and QCOW2 images reserve up front." }),
  mountpointFlag: (): StorageField => ({ key: "is_mountpoint", label: "Needs to be a mount", kind: "string", advanced: true, placeholder: "yes", pattern: "^(yes|no|1|0|true|false|/[^\\x00-\\x1f,]*)$", patternMessage: "Use yes, no or the path that has to be mounted.", help: "Say yes when the directory is a separate disk or share, so Proxmox treats it as offline when it isn't mounted instead of filling the system disk." }),
  maxProtected: (): StorageField => ({ key: "max-protected-backups", label: "Protected backups per machine", kind: "int", advanced: true, min: -1, max: 100000, help: "How many protected backups each machine may keep. -1 means no limit." }),
  contentDirs: (): StorageField => ({ key: "content-dirs", label: "Folder overrides", kind: "string", advanced: true, placeholder: "images=vm-disks", pattern: "^[\\w.-]+=[\\w./-]+(,[\\w.-]+=[\\w./-]+)*$", patternMessage: "Use content=folder pairs, separated by commas.", help: "Use other folder names than Proxmox's defaults, for example images=vm-disks." }),
  snapshotChain: (): StorageField => ({ key: "snapshot-as-volume-chain", label: "Snapshots as volume chains", kind: "bool", advanced: true, help: "Takes snapshots on storage that has no snapshots of its own, using chains of QCOW2 files." }),
  pool: (over: Partial<StorageField> = {}): StorageField => ({ key: "pool", label: "Pool", kind: "string", required: true, createOnly: true, pattern: NAME_RE, patternMessage: "Use letters, digits, . _ and -.", ...over }),
};

export const STORAGE_DEFS: StorageTypeDef[] = [
  {
    type: "dir",
    label: "Directory",
    summary: "A folder on this device. Works with any file system and holds every kind of content.",
    contents: FILE_CONTENT,
    defaultContent: ["images", "rootdir", "iso", "vztmpl", "backup"],
    canShare: true,
    prune: true,
    bwlimit: true,
    fields: [
      F.path(),
      F.mountpointFlag(),
      { key: "create-base-path", label: "Create the directory", kind: "bool", advanced: true, createOnly: true, help: "Create the directory if it doesn't exist." },
      { key: "create-subdirs", label: "Create the folder structure", kind: "bool", advanced: true, createOnly: true, help: "Fill the directory with Proxmox's folders (images, dump, template ...)." },
      F.format(),
      F.preallocation(),
      F.contentDirs(),
      F.maxProtected(),
      F.snapshotChain(),
    ],
  },
  {
    type: "nfs",
    label: "NFS share",
    summary: "A share from a network file server (NAS). Every device that mounts it sees the same files.",
    contents: FILE_CONTENT,
    defaultContent: ["images", "iso", "vztmpl", "backup"],
    alwaysShared: true,
    prune: true,
    bwlimit: true,
    fields: [
      F.server({ scan: "nfs" }),
      { key: "export", label: "Export", kind: "string", required: true, createOnly: true, placeholder: "/export/proxmox", pattern: PATH_RE, patternMessage: "Use the exported path, for example /export/proxmox.", help: "The path the server exports." },
      F.mountOptions(),
      F.format(),
      F.preallocation(),
      F.contentDirs(),
      F.maxProtected(),
      F.snapshotChain(),
    ],
  },
  {
    type: "cifs",
    label: "SMB / CIFS share",
    summary: "A Windows or Samba share. Good for ISO images and backups; sign in with a share account.",
    contents: FILE_CONTENT,
    defaultContent: ["iso", "vztmpl", "backup"],
    alwaysShared: true,
    prune: true,
    bwlimit: true,
    fields: [
      F.server({ scan: "cifs" }),
      { key: "share", label: "Share", kind: "string", required: true, createOnly: true, placeholder: "proxmox", pattern: "^[^\\x00-\\x1f,/\\\\]{1,128}$", patternMessage: "Use the share name, without slashes.", help: "The name of the share on the server." },
      F.username({ help: "The account that can read and write the share." }),
      F.password(),
      { key: "domain", label: "Domain", kind: "string", advanced: true, pattern: "^[\\w.-]{1,128}$", patternMessage: "Use a domain or workgroup name." },
      { key: "smbversion", label: "SMB version", kind: "enum", advanced: true, options: [{ value: "default", label: "Negotiate (default)" }, { value: "2.0", label: "2.0" }, { value: "2.1", label: "2.1" }, { value: "3", label: "3" }, { value: "3.0", label: "3.0" }, { value: "3.11", label: "3.11" }], help: "Leave on negotiate unless the server needs a specific version." },
      { key: "subdir", label: "Folder inside the share", kind: "string", advanced: true, placeholder: "/proxmox", pattern: PATH_RE, patternMessage: "Use an absolute path inside the share." },
      F.mountOptions(),
      F.format(),
      F.preallocation(),
      F.contentDirs(),
      F.maxProtected(),
    ],
  },
  {
    type: "pbs",
    label: "Proxmox Backup Server",
    summary: "A datastore on a Proxmox Backup Server. Holds deduplicated, optionally encrypted backups only.",
    contents: ["backup"],
    defaultContent: ["backup"],
    alwaysShared: true,
    prune: true,
    fields: [
      F.server({ scan: "pbs" }),
      { key: "port", label: "Port", kind: "int", advanced: true, min: 1, max: 65535, placeholder: "8007" },
      F.username({ required: true, createOnly: false, placeholder: "backup@pbs", help: "A user or API token id, for example backup@pbs or backup@pbs!token." }),
      F.password({ required: true, help: "The user's password or the API token secret. It is stored by Proxmox and never shown again." }),
      { key: "datastore", label: "Datastore", kind: "string", required: true, createOnly: true, pattern: NAME_RE, patternMessage: "Use the datastore name.", help: "The datastore on the backup server." },
      { key: "namespace", label: "Namespace", kind: "string", advanced: true, pattern: "^[\\w.-]+(/[\\w.-]+)*$", patternMessage: "Use a namespace path such as prod/web." },
      { key: "fingerprint", label: "Certificate fingerprint", kind: "secret", secret: true, advanced: false, pattern: "^([A-Fa-f0-9]{2}:){31}[A-Fa-f0-9]{2}$", patternMessage: "Use the SHA-256 fingerprint: 32 pairs of hex digits separated by colons.", help: "Needed when the server's certificate isn't signed by a public authority. Shown on the backup server's dashboard. Never shown again once saved." },
      { key: "encryption-key", label: "Encryption key", kind: "secret", secret: true, advanced: true, createOnly: true, pattern: "^(autogen|[\\s\\S]{1,8192})$", help: "Type autogen to have Proxmox create one. Keep a copy: backups can't be restored without it." },
      F.maxProtected(),
    ],
  },
  {
    type: "lvm",
    label: "LVM volume group",
    summary: "A volume group on this device. Fast block storage for virtual machines and containers, without snapshots.",
    contents: ["images", "rootdir"],
    defaultContent: ["images", "rootdir"],
    canShare: true,
    bwlimit: true,
    fields: [
      { key: "vgname", label: "Volume group", kind: "string", required: true, createOnly: true, pattern: NAME_RE, patternMessage: "Use the volume group's name.", scan: "lvm" },
      { key: "base", label: "Base volume", kind: "string", advanced: true, createOnly: true, pattern: "^[\\w.-]+:[\\w./-]+$", patternMessage: "Use a volume id such as storage:volume." },
      { key: "saferemove", label: "Wipe removed volumes", kind: "bool", advanced: true, help: "Zero a volume's data when it is removed, so the next owner of the space can't read it. Slower." },
      { key: "saferemove_throughput", label: "Wipe throughput", kind: "string", advanced: true, pattern: "^\\d+[kKmMgG]?$", patternMessage: "Use a number such as 10M." },
      { key: "saferemove-stepsize", label: "Wipe step size (MiB)", kind: "enum", advanced: true, options: [1, 2, 4, 8, 16, 32].map((n) => ({ value: String(n), label: `${n} MiB` })) },
      { key: "tagged_only", label: "Only volumes tagged for machines", kind: "bool", advanced: true },
    ],
  },
  {
    type: "lvmthin",
    label: "LVM-Thin pool",
    summary: "A thin pool on this device. Space is handed out as it is used, and snapshots and clones are instant.",
    contents: ["images", "rootdir"],
    defaultContent: ["images", "rootdir"],
    bwlimit: true,
    fields: [
      { key: "vgname", label: "Volume group", kind: "string", required: true, createOnly: true, pattern: NAME_RE, patternMessage: "Use the volume group's name.", scan: "lvm" },
      { key: "thinpool", label: "Thin pool", kind: "string", required: true, createOnly: true, pattern: NAME_RE, patternMessage: "Use the thin pool's name.", scan: "lvmthin" },
    ],
  },
  {
    type: "zfspool",
    label: "ZFS pool",
    summary: "A ZFS pool or dataset on this device. Snapshots, clones and checksums built in.",
    contents: ["images", "rootdir"],
    defaultContent: ["images", "rootdir"],
    bwlimit: true,
    fields: [
      F.pool({ label: "ZFS pool or dataset", placeholder: "rpool/data", pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$", scan: "zfs" }),
      { key: "blocksize", label: "Block size", kind: "string", advanced: true, placeholder: "16k", pattern: "^\\d+[kK]?$", patternMessage: "Use a size such as 16k.", help: "Block size of new volumes. Leave empty for the default." },
      { key: "sparse", label: "Thin provisioned", kind: "bool", advanced: true, help: "Do not reserve the full size of a volume up front." },
      { key: "mountpoint", label: "Mount point", kind: "string", advanced: true, pattern: PATH_RE, patternMessage: "Use an absolute path." },
    ],
  },
  {
    type: "iscsi",
    label: "iSCSI target",
    summary: "Disks exported by an iSCSI server. Every LUN becomes a raw disk you can give to a virtual machine.",
    contents: ["images"],
    defaultContent: ["images"],
    alwaysShared: true,
    fields: [
      { key: "portal", label: "Portal", kind: "string", required: true, createOnly: true, placeholder: "192.168.1.30:3260", pattern: SERVER_RE, patternMessage: "Use an address, with an optional :port.", scan: "iscsi" },
      { key: "target", label: "Target", kind: "string", required: true, createOnly: true, placeholder: "iqn.2003-01.org.example:disk1", pattern: "^[\\w.:@/-]{1,223}$", patternMessage: "Use the target's name, such as iqn.2003-01.org.example:disk1." },
    ],
  },
  {
    type: "iscsidirect",
    label: "iSCSI (direct)",
    summary: "Like iSCSI, but QEMU talks to the target itself instead of the host. Virtual machines only.",
    contents: ["images"],
    defaultContent: ["images"],
    alwaysShared: true,
    fields: [
      { key: "portal", label: "Portal", kind: "string", required: true, createOnly: true, pattern: SERVER_RE, patternMessage: "Use an address, with an optional :port.", scan: "iscsi" },
      { key: "target", label: "Target", kind: "string", required: true, createOnly: true, pattern: "^[\\w.:@/-]{1,223}$", patternMessage: "Use the target's name." },
    ],
  },
  {
    type: "cephfs",
    label: "CephFS",
    summary: "A Ceph file system. Needs a Ceph cluster; the key ring is stored by Proxmox and never shown again.",
    contents: ["vztmpl", "iso", "backup", "snippets", "import"],
    defaultContent: ["iso", "backup"],
    alwaysShared: true,
    prune: true,
    bwlimit: true,
    fields: [
      { key: "monhost", label: "Monitors", kind: "string", pattern: "^[\\w.:\\[\\]\\s,;-]{1,512}$", patternMessage: "Use monitor addresses separated by commas.", help: "Only for a Ceph cluster outside this one. Leave empty for the cluster Proxmox runs." },
      F.username({ placeholder: "admin" }),
      { key: "keyring", label: "Key ring", kind: "secret", secret: true, help: "The client's key ring contents, for an external cluster. Never shown again." },
      { key: "fs-name", label: "File system name", kind: "string", pattern: "^[A-Za-z][\\w.-]{0,63}$", patternMessage: "Use the Ceph file system's name." },
      { key: "path", label: "Path in the file system", kind: "string", createOnly: true, pattern: PATH_RE, patternMessage: "Use an absolute path.", placeholder: "/" },
      { key: "subdir", label: "Subdirectory", kind: "string", advanced: true, pattern: PATH_RE, patternMessage: "Use an absolute path." },
      { key: "fuse", label: "Mount through FUSE", kind: "bool", advanced: true, help: "Use the user-space client instead of the kernel client." },
      F.contentDirs(),
      F.maxProtected(),
    ],
  },
  {
    type: "rbd",
    label: "Ceph RBD",
    summary: "Block devices from a Ceph pool. Needs a Ceph cluster; the key ring is stored by Proxmox and never shown again.",
    contents: ["images", "rootdir"],
    defaultContent: ["images", "rootdir"],
    alwaysShared: true,
    bwlimit: true,
    fields: [
      F.pool({ label: "Pool" }),
      { key: "monhost", label: "Monitors", kind: "string", pattern: "^[\\w.:\\[\\]\\s,;-]{1,512}$", patternMessage: "Use monitor addresses separated by commas.", help: "Only for a Ceph cluster outside this one. Leave empty for the cluster Proxmox runs." },
      F.username({ label: "Ceph user", placeholder: "admin" }),
      { key: "keyring", label: "Key ring", kind: "secret", secret: true, help: "The client's key ring contents, for an external cluster. Never shown again." },
      { key: "krbd", label: "Use the kernel client", kind: "bool", advanced: true, help: "Always access images through the kernel module (required for containers on some setups)." },
      { key: "namespace", label: "Namespace", kind: "string", advanced: true, pattern: "^[\\w.-]+$", patternMessage: "Use letters, digits, . _ and -." },
      { key: "data-pool", label: "Data pool", kind: "string", advanced: true, pattern: NAME_RE, patternMessage: "Use the pool's name.", help: "For erasure coding only." },
    ],
  },
  {
    type: "btrfs",
    label: "BTRFS",
    summary: "A BTRFS file system on this device, with snapshots through subvolumes.",
    contents: FILE_CONTENT,
    defaultContent: ["images", "rootdir", "iso", "backup"],
    canShare: true,
    prune: true,
    bwlimit: true,
    fields: [
      F.path({ label: "Mount path" }),
      F.mountpointFlag(),
      { key: "nocow", label: "Disable copy-on-write", kind: "bool", advanced: true, help: "Faster, but disables checksums and data errors can't be repaired. Only for data you can lose." },
      F.preallocation(),
      F.contentDirs(),
      F.maxProtected(),
    ],
  },
  {
    type: "zfs",
    label: "ZFS over iSCSI",
    summary: "ZFS volumes on a remote storage server, exported over iSCSI. For storage servers that run one of the supported providers.",
    contents: ["images"],
    defaultContent: ["images"],
    alwaysShared: true,
    fields: [
      { key: "portal", label: "Portal", kind: "string", required: true, createOnly: true, pattern: SERVER_RE, patternMessage: "Use an address, with an optional :port." },
      F.pool({ label: "Pool on the server" }),
      { key: "target", label: "Target", kind: "string", required: true, createOnly: true, pattern: "^[\\w.:@/-]{1,223}$", patternMessage: "Use the target's name." },
      { key: "iscsiprovider", label: "Provider", kind: "enum", required: true, createOnly: true, options: [{ value: "comstar", label: "COMSTAR (Solaris, illumos)" }, { value: "istgt", label: "istgt (FreeBSD)" }, { value: "iet", label: "IET (Linux)" }, { value: "LIO", label: "LIO (Linux)" }], help: "The iSCSI software the server runs." },
      { key: "blocksize", label: "Block size", kind: "string", advanced: true, pattern: "^\\d+[kK]?$", patternMessage: "Use a size such as 16k." },
      { key: "sparse", label: "Thin provisioned", kind: "bool", advanced: true },
      { key: "nowritecache", label: "Disable write caching", kind: "bool", advanced: true },
      { key: "comstar_tg", label: "COMSTAR target group", kind: "string", advanced: true, pattern: NAME_RE },
      { key: "comstar_hg", label: "COMSTAR host group", kind: "string", advanced: true, pattern: NAME_RE },
      { key: "lio_tpg", label: "LIO target portal group", kind: "string", advanced: true, pattern: "^[\\w.-]{1,64}$" },
    ],
  },
  {
    type: "esxi",
    label: "VMware ESXi import",
    summary: "An ESXi host or vCenter to import virtual machines from. Read only: nothing is written to it.",
    contents: ["import"],
    defaultContent: ["import"],
    alwaysShared: true,
    fields: [
      F.server(),
      F.username({ required: true }),
      F.password({ required: true }),
      { key: "port", label: "Port", kind: "int", advanced: true, min: 1, max: 65535 },
      { key: "skip-cert-verification", label: "Skip certificate verification", kind: "bool", advanced: true, help: "Only on a network you fully trust." },
    ],
  },
];

export const storageDef = (type: string): StorageTypeDef | undefined => STORAGE_DEFS.find((d) => d.type === type);

/** The keys every storage type shares, besides its own fields. */
export const COMMON_KEYS = ["content", "nodes", "disable", "shared", "prune-backups", "bwlimit"] as const;

/** Never returned by the host service, whatever the type. */
export const SECRET_KEYS = ["password", "keyring", "encryption-key", "master-pubkey", "fingerprint"] as const;

export interface PruneSettings {
  keepAll: boolean;
  keepLast: number | null;
  keepHourly: number | null;
  keepDaily: number | null;
  keepWeekly: number | null;
  keepMonthly: number | null;
  keepYearly: number | null;
}

const PRUNE_KEYS: [keyof PruneSettings, string][] = [["keepLast", "keep-last"], ["keepHourly", "keep-hourly"], ["keepDaily", "keep-daily"], ["keepWeekly", "keep-weekly"], ["keepMonthly", "keep-monthly"], ["keepYearly", "keep-yearly"]];

export function parsePrune(raw: unknown): PruneSettings {
  const out: PruneSettings = { keepAll: false, keepLast: null, keepHourly: null, keepDaily: null, keepWeekly: null, keepMonthly: null, keepYearly: null };
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([k, v]) => `${k}=${v}`).join(",") : "";
  for (const part of text.split(",")) {
    const [k, v] = part.split("=");
    if (k === "keep-all") out.keepAll = v === "1";
    const m = PRUNE_KEYS.find(([, key]) => key === k);
    if (m && /^\d+$/.test(v ?? "")) (out[m[0]] as number | null) = Number(v);
  }
  return out;
}

/** The value Proxmox wants, or null when nothing is set (which means: delete the setting). Throws a user-facing Error. */
export function prunePropertyString(p: Partial<PruneSettings> | null | undefined): string | null {
  if (!p) return null;
  if (p.keepAll === true) {
    if (PRUNE_KEYS.some(([f]) => p[f] !== null && p[f] !== undefined)) throw new Error("Keep everything can't be combined with other retention settings");
    return "keep-all=1";
  }
  const parts: string[] = [];
  for (const [field, key] of PRUNE_KEYS) {
    const v = p[field];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 9999) throw new Error(`${key.replace("keep-", "Keep ")} must be a whole number from 1 to 9999`);
    parts.push(`${key}=${v}`);
  }
  return parts.length ? parts.join(",") : null;
}

export interface BwLimit {
  default: number | null;
  clone: number | null;
  migration: number | null;
  move: number | null;
  restore: number | null;
}

const BW_KEYS = ["default", "clone", "migration", "move", "restore"] as const;

export function parseBwlimit(raw: unknown): BwLimit {
  const out: BwLimit = { default: null, clone: null, migration: null, move: null, restore: null };
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? Object.entries(raw).map(([k, v]) => `${k}=${v}`).join(",") : "";
  for (const part of text.split(",")) {
    const [k, v] = part.split("=");
    if ((BW_KEYS as readonly string[]).includes(k) && /^\d+(\.\d+)?$/.test(v ?? "")) out[k as keyof BwLimit] = Number(v);
  }
  return out;
}

/** KiB/s per operation, or null when nothing is limited. Throws a user-facing Error. */
export function bwlimitPropertyString(b: Partial<BwLimit> | null | undefined): string | null {
  if (!b) return null;
  const parts: string[] = [];
  for (const k of BW_KEYS) {
    const v = b[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1e9) throw new Error(`The ${k} limit must be a number of KiB/s, 0 or more`);
    parts.push(`${k}=${Math.round(v)}`);
  }
  return parts.length ? parts.join(",") : null;
}

/** A node list as Proxmox writes it (comma separated) from an array, validated. */
export function nodeListString(nodes: unknown): string | null {
  if (nodes === null || nodes === undefined) return null;
  if (!Array.isArray(nodes)) throw new Error("Nodes is a list of device names");
  if (nodes.length === 0) return null;
  if (!nodes.every((n) => typeof n === "string" && /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?$/.test(n))) throw new Error("Device names use letters, digits and hyphens");
  return [...new Set(nodes as string[])].join(",");
}

/** Content types as a comma list, checked against what the storage type can hold. */
export function contentListString(def: StorageTypeDef, content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) throw new Error("Pick at least one kind of content");
  for (const c of content) if (typeof c !== "string" || !(CONTENT_TYPES as readonly string[]).includes(c)) throw new Error("Unknown kind of content");
  const bad = (content as string[]).find((c) => !def.contents.includes(c as ContentType));
  if (bad) throw new Error(`${def.label} can't hold ${CONTENT_LABELS[bad as ContentType].label.toLowerCase()}`);
  return [...new Set(content as string[])].join(",");
}

export interface StorageIssue {
  field: string;
  message: string;
}

/**
 * Checks a value against a field's rules; returns the text to send to Proxmox, or an issue. Booleans become 0/1 so the
 * caller can pass them straight through; an empty value is "not set".
 */
export function checkField(f: StorageField, raw: unknown): { value: string | number | boolean | undefined } | { issue: string } {
  if (raw === undefined || raw === null || raw === "") return f.required ? { issue: `${f.label} is required` } : { value: undefined };
  switch (f.kind) {
    case "bool":
      return typeof raw === "boolean" ? { value: raw } : { issue: `${f.label} is on or off` };
    case "int": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n)) return { issue: `${f.label} is a whole number` };
      if (f.min !== undefined && n < f.min) return { issue: `${f.label} must be ${f.min} or more` };
      if (f.max !== undefined && n > f.max) return { issue: `${f.label} must be ${f.max} or less` };
      return { value: n };
    }
    case "enum": {
      const v = String(raw);
      return f.options?.some((o) => o.value === v) ? { value: v } : { issue: `${f.label}: pick one of the choices` };
    }
    default: {
      if (typeof raw !== "string") return { issue: `${f.label} is text` };
      if (raw.length > 8192 || /[\x00\r]/.test(raw) || (f.kind !== "multiline" && f.kind !== "secret" && raw.includes("\n"))) return { issue: `${f.label} has characters Proxmox won't accept` };
      if (f.pattern && !new RegExp(f.pattern).test(raw)) return { issue: f.patternMessage ?? `${f.label} isn't valid` };
      return { value: raw };
    }
  }
}

export interface StorageSpecResult {
  /** Parameters to send to Proxmox (POST /storage or PUT /storage/{id}). */
  params: Record<string, string | number | boolean | undefined>;
  /** Settings to clear (PUT only). */
  remove: string[];
  issues: StorageIssue[];
}

/**
 * Turns what a person entered into Proxmox parameters, refusing anything the type doesn't have. `creating` allows the
 * create-only fields; on an edit they are refused (Proxmox ignores or rejects them), and an empty secret keeps what is
 * stored instead of clearing it.
 */
export function buildStorageParams(def: StorageTypeDef, input: Record<string, unknown>, creating: boolean): StorageSpecResult {
  const params: StorageSpecResult["params"] = {};
  const remove: string[] = [];
  const issues: StorageIssue[] = [];
  const known = new Set<string>([...def.fields.map((f) => f.key), ...COMMON_KEYS, "storage", "type", "digest", "delete"]);
  for (const k of Object.keys(input)) if (!known.has(k)) issues.push({ field: k, message: `${k} isn't a setting for ${def.label}` });

  for (const f of def.fields) {
    const raw = input[f.key];
    if (f.createOnly && !creating) {
      if (raw !== undefined && raw !== null && raw !== "") issues.push({ field: f.key, message: `${f.label} can't be changed after the storage is created` });
      continue;
    }
    if (f.secret && !creating && (raw === undefined || raw === null || raw === "")) continue; // keep what is stored
    if (f.required && !creating && !f.secret && (raw === undefined || raw === null || raw === "")) continue; // not touched
    const r = checkField(f, raw);
    if ("issue" in r) {
      issues.push({ field: f.key, message: r.issue });
      continue;
    }
    if (r.value === undefined) {
      if (!creating && !f.secret && raw === "" && !f.required) remove.push(f.key);
      continue;
    }
    params[f.key] = r.value;
  }

  const attempt = (field: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      issues.push({ field, message: (e as Error).message });
    }
  };
  if (input.content !== undefined || creating) attempt("content", () => void (params.content = contentListString(def, input.content)));
  if (input.nodes !== undefined) attempt("nodes", () => {
    const n = nodeListString(input.nodes);
    if (n) params.nodes = n;
    else remove.push("nodes");
  });
  if (input.disable !== undefined) {
    if (typeof input.disable === "boolean") params.disable = input.disable;
    else issues.push({ field: "disable", message: "Enabled or disabled" });
  }
  if (input.shared !== undefined) {
    if (typeof input.shared !== "boolean") issues.push({ field: "shared", message: "Shared is on or off" });
    else if (!def.canShare) issues.push({ field: "shared", message: `${def.label} is ${def.alwaysShared ? "always shared" : "never shared"}` });
    else params.shared = input.shared;
  }
  if (input["prune-backups"] !== undefined) {
    if (!def.prune) issues.push({ field: "prune-backups", message: `${def.label} has no backup retention settings` });
    else attempt("prune-backups", () => {
      const v = prunePropertyString(input["prune-backups"] as Partial<PruneSettings> | null);
      if (v) params["prune-backups"] = v;
      else remove.push("prune-backups");
    });
  }
  if (input.bwlimit !== undefined) {
    if (!def.bwlimit) issues.push({ field: "bwlimit", message: `${def.label} has no bandwidth limits` });
    else attempt("bwlimit", () => {
      const v = bwlimitPropertyString(input.bwlimit as Partial<BwLimit> | null);
      if (v) params.bwlimit = v;
      else remove.push("bwlimit");
    });
  }
  return { params, remove, issues };
}

/** Plain-language guidance for ZFS RAID levels: what it needs, what survives, and what capacity you get. */
export interface RaidLevel {
  value: string;
  label: string;
  minDisks: number;
  /** Disks that can fail without losing the pool. */
  tolerates: (n: number) => number;
  /** Usable bytes from n disks of the given size (smallest disk counts). */
  usable: (n: number, size: number, draid?: { data: number; spares: number }) => number;
  help: string;
}

export const RAID_LEVELS: RaidLevel[] = [
  { value: "single", label: "Single disk", minDisks: 1, tolerates: () => 0, usable: (_n, s) => s, help: "One disk, no redundancy. If it fails the data is gone. Fine for scratch space or when backups live elsewhere." },
  { value: "mirror", label: "Mirror (RAID1)", minDisks: 2, tolerates: (n) => n - 1, usable: (_n, s) => s, help: "Every disk holds a full copy. Survives all but one disk failing. Capacity of one disk. Fast reads; the best choice for virtual machines on two disks." },
  { value: "raid10", label: "Striped mirrors (RAID10)", minDisks: 4, tolerates: () => 1, usable: (n, s) => Math.floor(n / 2) * s, help: "Pairs of mirrors, striped together. Half the capacity, good speed for many virtual machines. Survives one failure per pair. Needs an even number of disks." },
  { value: "raidz", label: "RAID-Z1 (one parity disk)", minDisks: 3, tolerates: () => 1, usable: (n, s) => (n - 1) * s, help: "One disk's worth of parity. Survives one failure. Good capacity, slower writes than mirrors. Rebuilds on big disks take long, so prefer RAID-Z2 above 4 TB disks." },
  { value: "raidz2", label: "RAID-Z2 (two parity disks)", minDisks: 4, tolerates: () => 2, usable: (n, s) => (n - 2) * s, help: "Two disks' worth of parity. Survives two failures. A common choice for bulk storage and backups." },
  { value: "raidz3", label: "RAID-Z3 (three parity disks)", minDisks: 5, tolerates: () => 3, usable: (n, s) => (n - 3) * s, help: "Three disks' worth of parity. Survives three failures. For very large pools." },
  { value: "draid", label: "dRAID1 (distributed parity)", minDisks: 3, tolerates: () => 1, usable: (n, s, d) => Math.max(0, n - (d?.spares ?? 0) - 1) * s, help: "Like RAID-Z1 with spare space spread over all disks, so rebuilds are fast. For pools of many disks. Needs a data-disk and spare layout." },
  { value: "draid2", label: "dRAID2", minDisks: 4, tolerates: () => 2, usable: (n, s, d) => Math.max(0, n - (d?.spares ?? 0) - 2) * s, help: "Like RAID-Z2 with distributed spares. For pools of many disks." },
  { value: "draid3", label: "dRAID3", minDisks: 5, tolerates: () => 3, usable: (n, s, d) => Math.max(0, n - (d?.spares ?? 0) - 3) * s, help: "Like RAID-Z3 with distributed spares. For pools of many disks." },
];

export const ZFS_COMPRESSION = ["on", "off", "gzip", "lz4", "lzjb", "zle", "zstd"] as const;

export type ZfsPlan = { ok: true; usableBytes: number; tolerates: number } | { ok: false; message: string };

/** Checks a ZFS layout and previews the capacity. Disk sizes are in bytes; the smallest disk sets the size of each. */
export function planZfs(raidlevel: string, sizes: number[], draidConfig?: string | null): ZfsPlan {
  const level = RAID_LEVELS.find((l) => l.value === raidlevel);
  if (!level) return { ok: false, message: "Pick a RAID level" };
  if (sizes.length < level.minDisks) return { ok: false, message: `${level.label} needs at least ${level.minDisks} disk${level.minDisks === 1 ? "" : "s"}` };
  if (raidlevel === "single" && sizes.length !== 1) return { ok: false, message: "A single-disk pool uses exactly one disk" };
  if (raidlevel === "raid10" && sizes.length % 2 !== 0) return { ok: false, message: "RAID10 needs an even number of disks" };
  let draid: { data: number; spares: number } | undefined;
  if (raidlevel.startsWith("draid")) {
    const parsed = parseDraidConfig(draidConfig);
    if (!parsed) return { ok: false, message: "dRAID needs a layout such as data=4,spares=1" };
    draid = parsed;
    const parity = Number(raidlevel.slice(5) || 1);
    if (draid.data + parity + draid.spares > sizes.length) return { ok: false, message: "The layout needs more disks than you picked" };
  }
  const smallest = Math.min(...sizes);
  return { ok: true, usableBytes: level.usable(sizes.length, smallest, draid), tolerates: level.tolerates(sizes.length) };
}

export function parseDraidConfig(raw: string | null | undefined): { data: number; spares: number } | null {
  if (!raw) return null;
  const m = raw.match(/^(?:data=(\d{1,3}),spares=(\d{1,3})|spares=(\d{1,3}),data=(\d{1,3}))$/);
  if (!m) return null;
  const data = Number(m[1] ?? m[4]);
  const spares = Number(m[2] ?? m[3]);
  return data >= 1 && spares >= 0 ? { data, spares } : null;
}
