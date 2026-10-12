// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const watchTask = vi.fn();
const guestList = [
  { vmid: 100, name: "vm-lab", type: "qemu", template: false },
  { vmid: 101, name: "ct-web", type: "lxc", template: false },
  { vmid: 102, name: "vm-two", type: "qemu", template: false },
];

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live: false,
    watchTask,
    contentVersion: 0,
    setup: { deviceName: "pve" },
    data: { host: { storage: [{ id: "local", content: ["iso"] }] }, guests: guestList },
    backend: {
      machineOptions: async () => ({ nextid: 103, templates: [], isos: [], storages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e11 }], vmStorages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e11 }, { storage: "fast", type: "zfspool", avail: 1e11 }], pools: [] }),
      content: async () => [{ volid: "local:iso/debian.iso", content: "iso", format: "iso", size: 6e8, ctime: 1, vmid: null, notes: null, protected: false }],
    },
  }),
}));

import { DisksPage } from "../src/pages/disks/DisksPage.tsx";
import { StorageDefinitions } from "../src/pages/disks/StorageDefinitions.tsx";
import { DisksCard } from "../src/pages/machines/HardwareDisks.tsx";
import { demoDisksApi, resetDisksDemo } from "../src/data/engine/disksDemo.ts";

const view = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  resetDisksDemo();
  watchTask.mockReset();
});
afterEach(cleanup);

describe("Disks page", () => {
  it("lists physical disks with size, model, use, wear and health", async () => {
    view(<DisksPage />);
    const row = (await screen.findByText("nvme0n1")).closest("tr")!;
    expect(within(row).getByText("1 TB")).toBeTruthy();
    expect(within(row).getByText("Fast NVMe", { exact: false })).toBeTruthy();
    expect(within(row).getByText("3% life left")).toBeTruthy();
    const failing = screen.getByText("sdd").closest("tr")!;
    expect(within(failing).getByText("Failing")).toBeTruthy();
    expect(within(failing).getByText("LVM")).toBeTruthy();
  });

  it("keeps Wipe disabled until the disk's name is typed", async () => {
    view(<DisksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Wipe sdb" }));
    const go = await screen.findByRole("button", { name: "Wipe disk" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    const box = screen.getByLabelText("Type sdb to confirm");
    type(box, "sdc");
    expect((go as HTMLButtonElement).disabled).toBe(true);
    type(box, "sdb");
    expect((go as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(watchTask).toHaveBeenCalledWith(null, "Wipe sdb"));
  });

  it("shows the reason when a disk in use is wiped anyway", async () => {
    const spy = vi.spyOn(demoDisksApi, "wipe");
    view(<DisksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Wipe sdd" }));
    expect(await screen.findByText(/Proxmox will refuse this/)).toBeTruthy();
    type(screen.getByLabelText("Type sdd to confirm"), "sdd");
    fireEvent.click(screen.getByRole("button", { name: "Wipe disk" }));
    await waitFor(() => expect(screen.getByText(/can't be wiped: It is part of an LVM volume group/)).toBeTruthy());
    expect(spy).toHaveBeenCalled();
  });

  it("opens SMART detail", async () => {
    view(<DisksPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: /SMART/ }))[1]);
    expect(await screen.findByText("Reallocated_Sector_Ct")).toBeTruthy();
  });

  it("previews ZFS capacity and tolerance, and rejects layouts that don't fit", async () => {
    view(<DisksPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create storage/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "ZFS" }));
    type(screen.getByLabelText("Name"), "tank");
    fireEvent.click(screen.getByLabelText("Use sdb"));
    expect(screen.getByText(/needs at least 2 disks/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Use sdc"));
    expect(screen.getByText("4 TB usable")).toBeTruthy();
    expect(screen.getByText("Survives 1 disk failure")).toBeTruthy();
    type(screen.getByLabelText("RAID level"), "single");
    expect(screen.getByText(/exactly one disk/)).toBeTruthy();
    type(screen.getByLabelText("RAID level"), "raidz");
    expect(screen.getByText(/RAID-Z1 \(one parity disk\) needs at least 3 disks/)).toBeTruthy();
  });

  it("creates a ZFS pool through the API and watches the task", async () => {
    view(<DisksPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Create storage/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "ZFS" }));
    type(screen.getByLabelText("Name"), "tank");
    fireEvent.click(screen.getByLabelText("Use sdb"));
    fireEvent.click(screen.getByLabelText("Use sdc"));
    fireEvent.click(screen.getByRole("button", { name: /Create and erase disks/ }));
    await waitFor(() => expect(watchTask).toHaveBeenCalledWith(null, "Create ZFS pool tank"));
    expect((await demoDisksApi.listOnDisks("zfs")).map((z) => z.name)).toEqual(["tank"]);
    expect((await demoDisksApi.disks()).find((d) => d.name === "sdb")!.usedBy).toMatch(/ZFS/);
  });
});

describe("Storage settings", () => {
  it("lists every definition with what it holds and that credentials are stored, never the credentials", async () => {
    view(<StorageDefinitions />);
    const nas = (await screen.findByText("nas")).closest("div.relative")!;
    expect(within(nas as HTMLElement).getByText("Credentials stored")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/hunter2|password=/i);
    expect(screen.getByText(/Keeps 7 last, 4 weekly/)).toBeTruthy();
  });

  it("offers every storage type Proxmox offers", async () => {
    view(<StorageDefinitions />);
    fireEvent.click(await screen.findByRole("button", { name: /Add storage/ }));
    for (const label of ["Directory", "NFS share", "SMB / CIFS share", "Proxmox Backup Server", "LVM volume group", "LVM-Thin pool", "ZFS pool", "iSCSI target", "CephFS", "Ceph RBD"]) expect(await screen.findByText(label)).toBeTruthy();
  });

  it("adds an SMB share from a scan, with a write-only password", async () => {
    view(<StorageDefinitions />);
    fireEvent.click(await screen.findByRole("button", { name: /Add storage/ }));
    fireEvent.click((await screen.findByText("SMB / CIFS share")).closest("button")!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /Add storage$/ }));
    expect((await screen.findAllByText(/is required|Give the storage a name/)).length).toBeGreaterThan(0);
    type(screen.getByLabelText("Name"), "isos");
    type(screen.getByLabelText("Server"), "nas.lan");
    fireEvent.click(screen.getByRole("button", { name: /Find shares/ }));
    const picker = await screen.findByLabelText("Found shares");
    type(picker, "iso");
    expect((screen.getByLabelText(/^Share/) as HTMLInputElement).value).toBe("iso");
    const pw = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(pw.type).toBe("password");
    type(pw, "s3cret");
    const create = vi.spyOn(demoDisksApi, "createStorage");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Add storage$/ }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ type: "cifs", storage: "isos", server: "nas.lan", share: "iso", password: "s3cret" });
    const saved = (await demoDisksApi.storageDefs()).find((d) => d.id === "isos")!;
    expect(JSON.stringify(saved)).not.toContain("s3cret");
    expect(saved.secretsSet).toEqual(["password"]);
  });

  it("edits a storage, locks what Proxmox fixes at creation, and keeps the stored password", async () => {
    view(<StorageDefinitions />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit nas" }));
    const server = (await screen.findByLabelText(/^Server/)) as HTMLInputElement;
    expect(server.disabled).toBe(true);
    expect((screen.getByLabelText(/^Password/) as HTMLInputElement).placeholder).toMatch(/Stored/);
    fireEvent.click(screen.getByLabelText(/^ISO images/));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull());
    const nas = (await demoDisksApi.storageDefs()).find((d) => d.id === "nas")!;
    expect(nas.content).toEqual(["backup"]);
    expect(nas.secretsSet).toEqual(["password"]);
  });

  it("removes a storage only after its name is typed, and warns about what uses it", async () => {
    view(<StorageDefinitions />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove local-lvm" }));
    expect(await screen.findByText(/vm-lab|web/, { exact: false })).toBeTruthy();
    expect(screen.getByText("Still in use")).toBeTruthy();
    const go = screen.getByRole("button", { name: "Remove storage" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(screen.getByLabelText("Type local-lvm to confirm"), "local-lvm");
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(async () => expect((await demoDisksApi.storageDefs()).some((d) => d.id === "local-lvm")).toBe(false));
  });
});

describe("Machine disks", () => {
  const g = { vmid: 100, name: "vm-lab" } as never;
  const card = (kind: "qemu" | "lxc" = "qemu", vmid = 100) => view(<DisksCard g={{ ...(g as object), vmid } as never} kind={kind} running={false} onGrow={() => {}} version={0} onChanged={() => {}} />);

  it("adds a disk with options, then detaches it into a detached disk and destroys it only after the name is typed", async () => {
    card();
    expect(await screen.findByText("scsi0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add disk/ }));
    type(await screen.findByLabelText("Size (GB)"), "16");
    fireEvent.click(screen.getByLabelText(/^Discard \(TRIM\)/));
    fireEvent.click(screen.getAllByRole("button", { name: "Add disk" }).at(-1)!);
    expect(await screen.findByText("scsi1")).toBeTruthy();
    expect(screen.getAllByText("discard")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Detach scsi1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Detach disk" }));
    expect(await screen.findByText("Detached disks")).toBeTruthy();
    const destroy = screen.getByRole("button", { name: /^Destroy / });
    const name = destroy.getAttribute("aria-label")!.replace("Destroy ", "");
    fireEvent.click(destroy);
    const go = (await screen.findByRole("button", { name: "Destroy disk" })) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(screen.getByLabelText(`Type ${name} to confirm`), name);
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(screen.queryByText("Detached disks")).toBeNull());
  });

  it("changes and ejects the CD drive from the ISO list", async () => {
    card();
    fireEvent.click(await screen.findByRole("button", { name: /Insert/ }));
    expect(await screen.findByText("local:iso/debian.iso")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Insert image" }));
    await waitFor(() => expect(screen.getByText("debian.iso")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Eject" }));
    expect(await screen.findByText("Empty")).toBeTruthy();
  });

  it("moves a disk to another storage as a watched task", async () => {
    card();
    fireEvent.click(await screen.findByRole("button", { name: "Move scsi0" }));
    type(await screen.findByLabelText("Target storage"), "fast");
    fireEvent.click(screen.getByRole("button", { name: "Move disk" }));
    await waitFor(() => expect(watchTask).toHaveBeenCalledWith("", "Move scsi0 of vm-lab to fast"));
  });

  it("gives containers mount points, with a bind mount warning for administrators", async () => {
    card("lxc", 101);
    expect(await screen.findByText("rootfs")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Detach rootfs/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Add mount point/ }));
    type(await screen.findByLabelText("Path inside the container"), "/data");
    fireEvent.click(screen.getAllByRole("button", { name: "Add mount point" }).at(-1)!);
    expect(await screen.findByText("mp0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add mount point/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /Host folder/ }));
    expect(screen.getByText(/Bind mounts share the host's files/)).toBeTruthy();
  });
});
