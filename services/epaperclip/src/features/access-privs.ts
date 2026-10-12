/**
 * Every privilege Proxmox knows (the property list of GET /access/roles/{roleid}), grouped, with a plain-language
 * description. Roles are sets of these; ACLs give a role to a user, group or token on a path.
 */
export interface Privilege {
  name: string;
  group: string;
  description: string;
}

const G = { vm: "Machines", ds: "Storage", sys: "Device", acc: "People and access", pool: "Resource groups", sdn: "Networking (SDN)", map: "Hardware mappings" };

export const PRIVILEGES: Privilege[] = [
  { name: "VM.Audit", group: G.vm, description: "See a machine and its configuration." },
  { name: "VM.Allocate", group: G.vm, description: "Create, delete and restore machines." },
  { name: "VM.Clone", group: G.vm, description: "Clone a machine." },
  { name: "VM.Backup", group: G.vm, description: "Back up and restore a machine." },
  { name: "VM.Console", group: G.vm, description: "Open a machine's console." },
  { name: "VM.PowerMgmt", group: G.vm, description: "Start, stop, reboot and suspend a machine." },
  { name: "VM.Migrate", group: G.vm, description: "Move a machine to another device." },
  { name: "VM.Snapshot", group: G.vm, description: "Create and delete snapshots." },
  { name: "VM.Snapshot.Rollback", group: G.vm, description: "Roll a machine back to a snapshot." },
  { name: "VM.Replicate", group: G.vm, description: "Manage replication of a machine." },
  { name: "VM.Config.CDROM", group: G.vm, description: "Change or eject the CD/DVD drive." },
  { name: "VM.Config.CPU", group: G.vm, description: "Change processor settings." },
  { name: "VM.Config.Memory", group: G.vm, description: "Change memory settings." },
  { name: "VM.Config.Disk", group: G.vm, description: "Add, resize and remove disks." },
  { name: "VM.Config.Network", group: G.vm, description: "Change network devices." },
  { name: "VM.Config.HWType", group: G.vm, description: "Change hardware types such as machine type and BIOS." },
  { name: "VM.Config.Cloudinit", group: G.vm, description: "Change cloud-init settings." },
  { name: "VM.Config.Options", group: G.vm, description: "Change other options such as name, boot order and start at boot." },
  { name: "VM.GuestAgent.Audit", group: G.vm, description: "Read information from the guest agent." },
  { name: "VM.GuestAgent.FileRead", group: G.vm, description: "Read files through the guest agent." },
  { name: "VM.GuestAgent.FileWrite", group: G.vm, description: "Write files through the guest agent." },
  { name: "VM.GuestAgent.FileSystemMgmt", group: G.vm, description: "Freeze, thaw and trim file systems through the guest agent." },
  { name: "VM.GuestAgent.Unrestricted", group: G.vm, description: "Run any guest agent command, including running programs." },
  { name: "Datastore.Audit", group: G.ds, description: "See a storage and what is on it." },
  { name: "Datastore.AllocateSpace", group: G.ds, description: "Create disks and backups on a storage." },
  { name: "Datastore.AllocateTemplate", group: G.ds, description: "Upload and remove ISO images and container templates." },
  { name: "Datastore.Allocate", group: G.ds, description: "Create, change and remove storages." },
  { name: "Sys.Audit", group: G.sys, description: "See the device's status, logs and configuration." },
  { name: "Sys.Modify", group: G.sys, description: "Change the device's configuration, including roles." },
  { name: "Sys.Console", group: G.sys, description: "Open the device's own console." },
  { name: "Sys.PowerMgmt", group: G.sys, description: "Shut down, reboot and wake the device." },
  { name: "Sys.Syslog", group: G.sys, description: "Read the system log." },
  { name: "Sys.AccessNetwork", group: G.sys, description: "Make the device fetch from the network (downloads, tests)." },
  { name: "Sys.Incoming", group: G.sys, description: "Receive migrations and replicated data from other devices." },
  { name: "User.Modify", group: G.acc, description: "Create, change and delete users, and their tokens." },
  { name: "Group.Allocate", group: G.acc, description: "Create, change and delete groups." },
  { name: "Permissions.Modify", group: G.acc, description: "Change who has which role on a path." },
  { name: "Realm.Allocate", group: G.acc, description: "Create, change and delete login realms." },
  { name: "Realm.AllocateUser", group: G.acc, description: "Assign users to a realm." },
  { name: "Pool.Audit", group: G.pool, description: "See a resource group and what is in it." },
  { name: "Pool.Allocate", group: G.pool, description: "Create and delete resource groups, and change what is in them." },
  { name: "SDN.Audit", group: G.sdn, description: "See software-defined network zones and virtual networks." },
  { name: "SDN.Use", group: G.sdn, description: "Attach machines to a virtual network." },
  { name: "SDN.Allocate", group: G.sdn, description: "Create and change zones and virtual networks." },
  { name: "Mapping.Audit", group: G.map, description: "See hardware mappings." },
  { name: "Mapping.Use", group: G.map, description: "Give a machine a mapped device." },
  { name: "Mapping.Modify", group: G.map, description: "Create and change hardware mappings." },
];

export const PRIVILEGE_NAMES = new Set(PRIVILEGES.map((p) => p.name));

export const ROLE_ID = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;
