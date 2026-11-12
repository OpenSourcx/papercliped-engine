# Fast storage for agent containers (ZFS), explained for people who have never used ZFS

Every time an agent runs, ePaperclip gives it its own container: a small, locked-down machine that is made from a template, used, and thrown away. **How fast that container appears depends on one thing: the kind of storage it is made on.** This page explains the difference, how to check what you have, and how to get the fast kind with ZFS. You do not need to know anything about ZFS first.

> **What works today, and what is planned**
>
> | | |
> | --- | --- |
> | **Works today** | ePaperclip notices when the storage can make instant containers, and uses that automatically. You can set up ZFS yourself by following [section 6](#6-set-it-up-on-a-spare-disk-about-10-minutes) and then choose it in **Settings → Agent containers**. |
> | **Planned, not in V1 yet** | The console finding a spare disk and offering to set ZFS up for you, offering a file-based pool when there is no spare disk, and the "Why sandboxes are slow here" card. They are described in [section 8](#8-planned-what-the-console-will-do) so you know where this is going. Nothing in section 8 happens by itself today. |

## 1. The short version

- On **ordinary folder-style storage** ("directory" storage), every container is a **full copy** of the template. That copy is about 4 GB, so a new container takes **about two minutes** to appear on a spinning disk.
- On **ZFS storage**, a container is a **clone**: it shares the template's data and only stores what it changes. It appears in **a few seconds** and uses almost no extra space.
- ePaperclip works on both. ZFS just makes the waiting go away. If you have a disk you can dedicate to it, it is worth it.

## 2. Why are my agent containers slow to start?

Think of the template as a finished document and every agent run as needing its own copy.

- **A full copy** is photocopying every page, every time. It takes as long as the document is thick, and each copy takes up paper.
- **A clone** is putting a transparent sheet over the original. You only write on the sheet. It takes no time, and the pile of sheets is tiny.

Directory storage can only photocopy. ZFS can do the transparent sheet. That is the whole difference.

What it looked like when we measured it on a test machine (your numbers will differ):

| Storage | Time to get a new container | Disk used per container |
| --- | --- | --- |
| ZFS, clone | **about 2 seconds** | **about 200 KB** |
| ZFS, full copy (for comparison) | about 48 seconds | about 2 GB |
| Directory storage on a spinning disk | about 2 minutes | about 3.8 GB |

You mostly notice this the first time an agent runs after setup, when you connect an AI account (the sign-in window is only a few minutes long), and on machines with slow disks. ePaperclip reuses a stopped container where it can, so later runs are quicker, but a fast clone is better than any workaround.

## 3. What is ZFS, in plain words?

ZFS is a way of storing data. It comes built into Proxmox, so there is nothing to download. For our purposes:

- **It can clone instantly.** This is the reason we want it.
- **It checks its own data.** Every block has a checksum, so quiet corruption is noticed.
- **It compresses automatically,** which saves space and often makes slow disks feel faster.
- **It uses some memory as a cache** (called the ARC). By default it will take up to half your RAM, which is far too much next to ePaperclip's engine. [Section 6](#6-set-it-up-on-a-spare-disk-about-10-minutes) shows how to cap it.
- **One disk means no self-repair.** ZFS will tell you if data is damaged, but it can only fix it if there is a second copy (a mirror). Agent containers are disposable, so one disk is fine. Do not keep anything precious on it.

The terms you will see:

| Word | What it means |
| --- | --- |
| **pool** | The ZFS storage you build from one or more disks. We call ours `tank`. |
| **dataset** | A folder-like area inside the pool with its own settings. We use `tank/sandboxes`. |
| **clone** | A new container that shares the template's data and stores only its own changes. |
| **ARC** | ZFS's memory cache. |
| **mirror** | Two disks holding the same data, so one can fail. |

## 4. Do I need it? Check what you have

| Your storage type | New container | Do you need ZFS? |
| --- | --- | --- |
| **ZFS** (`zfspool`), **LVM-thin**, **btrfs**, **Ceph** | Instant clone | No. You already have the fast kind. |
| **Directory** (`dir`), **NFS**, **SMB/CIFS**, ordinary **LVM** | Full copy | Not required, but ZFS would make it much faster. |

To see yours: in Proxmox open **Datacenter → Storage**, or run `pvesm status` in the host's shell. The **Type** column shows `zfspool`, `lvmthin`, `dir` and so on. A fresh Proxmox install on a plain disk usually gives you `local` (a directory) and, if you chose LVM at install, `local-lvm` (LVM-thin). **If you have `local-lvm`, you already have fast containers.**

## 5. If you already have fast storage

Open **Settings → Agent containers** and pick that storage under **Container storage**, then **Set up agent containers**. ePaperclip detects it and clones instead of copying. Nothing else to do.

## 6. Set it up on a spare disk (about 10 minutes)

You need **a disk that holds nothing you want**. The steps below **erase it completely**. Do not use the disk Proxmox itself is installed on.

You will type commands in the host's shell (**Node → Shell** in Proxmox, or SSH as root). Each step says what it does and what you should see.

### Step 1: Find the disk, and be certain

```sh
lsblk -o NAME,SIZE,TYPE,ROTA,FSTYPE,MOUNTPOINT,MODEL
```

This lists every disk. Look for the one you mean to use. A disk is **unused** only if it has **no partitions, no file system, and no mount point**. Anything with `/` or `/boot/efi` next to it is Proxmox's own disk. `ROTA 1` means a spinning disk, `0` means SSD.

Now get its permanent name, which is safer than `sdb` because letters can change between reboots:

```sh
ls -l /dev/disk/by-id | grep -v part
```

Find the line ending in your disk (for example `... ata-ST2000VM003-1CT164_W1H0CC73 -> ../../sdb`) and note the long name before the arrow. We call it `<DISK-ID>` below.

> **Stop and check.** Read the model and size back to yourself. If there is any doubt that this is the right disk, do not continue.

### Step 2: Create the pool

```sh
zpool create -f -o ashift=12 -O compression=lz4 -O atime=off -O xattr=sa -O acltype=posixacl tank /dev/disk/by-id/<DISK-ID>
zfs create tank/sandboxes
```

| Piece | What it does |
| --- | --- |
| `-f` | Overwrites whatever was on the disk. **This is the erase.** |
| `ashift=12` | Matches modern disk sectors. Always right for current disks. |
| `compression=lz4` | Saves space; almost no cost. |
| `atime=off` | Stops writing on every read. Faster. |
| `xattr=sa`, `acltype=posixacl` | What containers need to behave like real Linux machines. |
| `tank` | The name of the pool. Any name is fine. |
| `tank/sandboxes` | A dataset just for agent containers. |

Check it:

```sh
zpool status tank
```

You should see `state: ONLINE` and your disk listed with `0` errors.

*Optional, SSD only:* `zpool set autotrim=on tank`. Do not do this on a spinning disk.

*Optional, two disks:* to get self-repair, put both in a mirror: `zpool create ... tank mirror /dev/disk/by-id/<DISK-A> /dev/disk/by-id/<DISK-B>`. (This is standard ZFS; we have not tested ePaperclip on a mirror ourselves.)

### Step 3: Cap ZFS's memory

Without a cap, ZFS can take up to half of your RAM. Four gigabytes is plenty for this job:

```sh
echo "options zfs zfs_arc_max=4294967296" > /etc/modprobe.d/zfs-epaperclip.conf
echo 4294967296 > /sys/module/zfs/parameters/zfs_arc_max
```

The first line makes the limit permanent across reboots; the second applies it right now. (`4294967296` is 4 GiB in bytes. Use `2147483648` for 2 GiB on a small machine.)

### Step 4: Tell Proxmox about it

```sh
pvesm add zfspool sandboxes --pool tank/sandboxes --content rootdir,images --sparse 1
pvesm status
```

You should now see a storage called `sandboxes` of type `zfspool` and the size of your disk.

### Step 5: Point ePaperclip at it

1. Open **Settings → Agent containers**.
2. Under **Container storage**, choose **sandboxes**. (**Template storage** only holds the downloaded operating-system file; leave it alone.)
3. Click **Set up agent containers** (or **Check and repair**).

**If you set up agent containers before** and the template was built on other storage, it must be rebuilt on the fast storage, because a clone can only be made from a template that lives on the same ZFS storage. Use **Remove agent containers** first (you have to type `remove agent containers` to confirm), then **Set up agent containers** again with **sandboxes** chosen. Removing deletes only what ePaperclip created for agent containers: the sandbox environments, the sandbox user and its token, the template, and the shared pool if it is empty. **Your organizations and agents are not deleted,** and setup creates the environments again. Setup takes several minutes because it rebuilds the template.

### Step 6: Check that it worked

Run any agent task, then look at a new agent container in Proxmox, or run:

```sh
pct list
pct config <the new container's id>
```

On fast storage the `rootfs` line looks like `sandboxes:basevol-100-disk-0/subvol-101-disk-0`. **`basevol/subvol` means it is a clone.** On slow storage you will see a plain `rootfs: local:101/vm-101-disk-0...` instead. You can also look in the service log:

```sh
journalctl -u epaperclip-engine | grep "Creating Proxmox container"
```

and look for `mode: clone:linked`. (`clone:full` means a full copy.)

## 7. If you have no spare disk

ePaperclip still works. The first container after setup takes about two minutes on directory storage, and ePaperclip then reuses a stopped container so later runs are quicker. The only trade-off of reuse is that files an agent leaves in its container stay there for that organization's next run. They are never shared between organizations.

Your options, best first:

1. **Add a second disk** (even a small one; a used 120 GB SSD is plenty) and follow [section 6](#6-set-it-up-on-a-spare-disk-about-10-minutes).
2. **Install Proxmox with ZFS or LVM-thin** the next time you reinstall.
3. **Wait for the file-based option** described in the next section, which gives you clones on any machine at some cost.

## 8. Planned: what the console will do

*Not built yet. This is the design, so you know what to expect.* The rule underneath it all: **ePaperclip will never erase a disk without you typing a confirmation.**

When you set up agent containers, ePaperclip will:

1. **If a fast storage already exists** (ZFS, LVM-thin, btrfs or Ceph), use it automatically and say so.
2. **If not, and it finds a truly unused disk** (no partitions, not mounted, not in LVM or ZFS), show the disk's name, size and model and offer **"Create fast storage on this disk."** You will have to type the word the screen asks for. The text will say clearly that it **erases the disk**.
3. **If there is no spare disk,** offer a **ZFS pool stored in a file** on your existing storage, with a plain warning: it gives you instant clones on any Proxmox machine, but it is slower than a real disk and carries boot-order risks (the file's storage must be ready before ZFS starts). This option will always be your choice, never the default for a machine that has a spare disk.
4. **Show a "Why sandboxes are slow here" card** whenever the chosen storage cannot clone. The text of the card is below.

### The card

> **Why sandboxes are slow here**
> Your agent containers are stored on *\[storage name\]*, which makes a full copy of the template (about 4 GB) every time. On this kind of storage that takes around two minutes. Storage that can clone, such as ZFS, makes the same container in a few seconds.
>
> **What you can do**
> - *\[If a spare disk was found\]* Use *\[disk name, size\]* for fast storage. This erases the disk. **[Create fast storage…]**
> - Add a disk or choose different storage. **[How to set up ZFS]**
> - Keep going as it is. Everything works; the first container is just slow to start.

## 9. Questions

**Will this erase my virtual machines or containers?**
Only the disk you choose in Step 1. Everything else is untouched. Nothing is created on Proxmox's own system disk.

**Can I use the same disk Proxmox is installed on?**
We do not recommend it. Use a separate disk.

**What if the disk fails?**
The pool is lost, and with it the agent containers on it. They are disposable, and ePaperclip makes new ones. That is why you should keep nothing you care about on it, and why backups of your real machines should go somewhere else.

**How do I check it is healthy?**
`zpool status` shows `ONLINE` and zero errors. `zpool status -x` says "all pools are healthy". Debian schedules a monthly check (a "scrub") automatically.

**How much memory does it use?**
Up to the cap you set in Step 3, and it gives memory back when other programs need it.

**Does it work on ARM or small devices?**
It works wherever your Proxmox kernel includes ZFS. Check with `zpool --version`. On a machine with little RAM, use a 1 or 2 GiB cap.

**How do I undo it?**
Remove agent containers in ePaperclip first, then:
```sh
pvesm remove sandboxes
zpool destroy tank
```
`zpool destroy` erases the pool. The disk is then free to use for something else.

**It says the pool is not there after a reboot.**
Run `zpool import -a`, then `zpool status`. If that fixes it, check that `zfs-import-cache.service` and `zfs-mount.service` are enabled (`systemctl is-enabled zfs-import-cache.service zfs-mount.service`).

**Setup finished, but containers are still slow.**
Run `pct config` on a new container (Step 6). If it is not a `basevol/subvol` clone, the template is on the old storage. Use **Remove agent containers**, then set up again with the ZFS storage chosen.

## 10. For contributors

- Linked clones are chosen by `resolveCloneMode` in `plugins/proxmox-sandbox/src/plugin.ts`: the template must be a Proxmox template on `lvmthin`, `zfspool`, `btrfs` or `rbd` storage. `cloneMode` defaults to `auto`, so nobody chooses it.
- Timeouts and lease reuse follow the storage class (`acquisitionTimeoutForStorage`, `reuseLeaseForStorage` in `services/epaperclip/src/containers.ts`).
- The measurements in section 2 were taken on a nested Proxmox VE 9.2 test host with a virtual ZFS disk; see `docs/` in the papercliped-docs repository (`STATUS.md`, ERR-PERF-001).
- The planned flow in section 8 must keep one invariant: **no disk is written to without a typed confirmation that names the disk.**
