// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { OS_TYPES, buildCt, buildVm, type OsType } from "@papercliped-engine/proxmox-client/wizard-schema";

const watchTask = vi.fn();
const notify = vi.fn();
const createVm = vi.fn(async (_spec: Record<string, unknown>) => ({ ok: true as const, vmid: 120 }));
const createMachine = vi.fn(async (_spec: Record<string, unknown>) => ({ ok: true as const, vmid: 121 }));
const state = { live: false };
const guests = [{ vmid: 100, name: "vm-lab", type: "qemu" }, { vmid: 101, name: "ct-web", type: "lxc" }];
const orgs = [{ slug: "acme", name: "Acme", resourceGroup: { pool: "epc-acme", maxGuests: 1, cores: 2, memoryMb: 2048, diskGb: 20 } }];

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live: state.live,
    watchTask,
    notify,
    createVm,
    createMachine,
    contentVersion: 0,
    setup: { deviceName: "pve" },
    data: { guests, orgs },
    backend: {
      machineOptions: async () => ({
        nextid: 0,
        templates: [{ volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", name: "Debian 12 standard", size: 1.2e8 }],
        isos: [{ volid: "local:iso/debian-12.iso", name: "debian-12.iso", size: 6e8 }, { volid: "local:iso/win11.iso", name: "win11.iso", size: 5e9 }],
        storages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e11 }],
        vmStorages: [{ storage: "local-lvm", type: "lvmthin", avail: 5e11 }, { storage: "nas", type: "nfs", avail: 1e12 }],
        pools: ["epc-acme"],
      }),
    },
  }),
}));

import { NewMachineModal } from "../src/pages/machines/NewMachine.tsx";
import { defaultCt, defaultVm, ctSpec, vmSpec, applyOsDefaults } from "../src/pages/machines/wizard/state.ts";
import { checkSpec, type WizardOptions } from "../src/data/engine/wizard.ts";

const open = (search = "") => {
  window.history.replaceState({}, "", `/pve/machines${search}`);
  return render(<MemoryRouter><NewMachineModal onClose={vi.fn()} /></MemoryRouter>);
};
const steps = () => within(screen.getByRole("navigation", { name: "Steps" }));
const step = (name: RegExp | string) => fireEvent.click(steps().getByRole("button", { name }));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const field = (name: string) => screen.getByLabelText(name, { selector: "input,select,textarea" }) as HTMLInputElement;
const ready = async () => await screen.findByLabelText(/^(Name|Hostname)$/);

beforeEach(() => {
  state.live = false;
  for (const f of [watchTask, notify, createVm, createMachine]) f.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the wizards' forms", () => {
  const options: WizardOptions = {
    nextid: 300, node: "pve", templates: [{ volid: "local:vztmpl/d.tar.zst", name: "d", size: null }], isos: [{ volid: "local:iso/a.iso", name: "a.iso", size: null }],
    vmStorages: [{ storage: "local-lvm", type: "lvmthin", avail: null, formats: ["raw"] }], ctStorages: [{ storage: "local-lvm", type: "lvmthin", avail: null, formats: ["raw"] }],
    pools: [], bridges: [{ id: "vmbr0", kind: "bridge" }], cpuTypes: { common: ["x86-64-v2-AES", "host"], custom: [], host: [] }, machines: [], rawPassthrough: true, pci: [], usb: [], pciMappings: [], usbMappings: [], isAdmin: true, notes: [],
  };
  it("start valid for every operating system, and for a container", () => {
    for (const os of OS_TYPES) {
      const form = applyOsDefaults(defaultVm(options, "m1", "small"), os as OsType);
      const r = checkSpec("vm", vmSpec(form), options);
      expect(r.ok, `${os}: ${r.ok ? "" : r.message}`).toBe(true);
    }
    expect(checkSpec("ct", ctSpec(defaultCt(options, "c1", "small", "local:vztmpl/d.tar.zst")), options).ok).toBe(true);
  });
  it("turns every empty optional box into nothing, never an invented value", () => {
    const spec = vmSpec(defaultVm(options, "m1", "small"));
    expect(spec.general.vmid).toBeUndefined();
    expect(spec.cpu.limit).toBeUndefined();
    expect(spec.cloudInit).toBeUndefined();
    const r = buildVm(JSON.parse(JSON.stringify(spec)), 5, {});
    expect(r.params.cpulimit).toBeUndefined();
    expect(buildCt(JSON.parse(JSON.stringify(ctSpec(defaultCt(options, "c1", "small", "local:vztmpl/d.tar.zst")))), 5, {}).params.password).toBeUndefined();
  });
  it("reports a bad field with a sentence", () => {
    const form = defaultVm(options, "m1", "small");
    form.disks[0].sizeGb = "0";
    const r = checkSpec("vm", vmSpec(form), options);
    expect(r).toMatchObject({ ok: false, field: "disks.0.sizeGb" });
  });
});

describe("Create container (demo)", () => {
  it("starts with the container wizard, its eight steps and sensible defaults", async () => {
    open();
    await ready();
    expect(steps().getAllByRole("button").map((b) => b.textContent!.replace(/^\d+/, "").trim())).toEqual(["General", "Template", "Disk", "CPU", "Memory", "Network", "DNS and features", "Confirm"]);
    expect(field("Hostname").value).toBe("quick-1");
  });

  it("creates a container from the confirm step", async () => {
    open();
    await ready();
    type(field("Hostname"), "ct-demo");
    step(/Template/);
    expect(field("Template").value).toContain("debian-12");
    step(/Confirm/);
    expect(await screen.findByText("ct-demo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
    await waitFor(() => expect(createMachine).toHaveBeenCalled());
    expect(createMachine.mock.calls[0][0]).toMatchObject({ name: "ct-demo", template: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", storage: "local-lvm", cores: 1, memoryMb: 1024, diskGb: 8 });
    expect(notify).toHaveBeenCalled();
  });

  it("refuses a bad static address where the person can fix it, and keeps Create off", async () => {
    open();
    await ready();
    step(/Network/);
    type(field("IPv4"), "static");
    type(field("IPv4 address"), "999.1.1.1/24");
    expect(await screen.findAllByText(/IPv4 address needs an address with its prefix length/)).not.toHaveLength(0);
    step(/Confirm/);
    expect((screen.getByRole("button", { name: "Create and start" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/One thing needs fixing/)).toBeTruthy();
  });

  it("shows IPv6, gateway, VLAN, firewall, rate and MAC fields and builds net0 from them", async () => {
    open();
    await ready();
    step(/Network/);
    type(field("IPv4"), "static");
    type(field("IPv4 address"), "10.0.30.5/24");
    type(field("IPv4 gateway"), "10.0.30.1");
    type(field("IPv6"), "static");
    type(field("IPv6 address"), "2001:db8::5/64");
    type(field("VLAN tag"), "30");
    type(field("Rate limit"), "50");
    type(field("MAC address"), "bc:24:11:00:00:01");
    step(/Confirm/);
    fireEvent.click(screen.getByRole("button", { name: /What will be sent to Proxmox/ }));
    const sent = (await screen.findByLabelText("Proxmox request")).textContent!;
    expect(sent).toContain("net0 = name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:01,firewall=1,rate=50,tag=30,ip=10.0.30.5/24,gw=10.0.30.1,ip6=2001:db8::5/64");
  });

  it("keeps the root password write-only", async () => {
    open();
    await ready();
    const pw = field("Root password");
    expect(pw.type).toBe("password");
    type(pw, "correct-horse-battery");
    type(field("SSH public key"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop");
    step(/Confirm/);
    expect(await screen.findByText(/root password set/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /What will be sent to Proxmox/ }));
    await screen.findByLabelText("Proxmox request");
    expect(document.body.textContent).not.toContain("correct-horse-battery");
    expect(document.body.textContent).not.toContain("AAAAC3NzaC1lZDI1NTE5");
    expect(screen.getByLabelText("Proxmox request").textContent).toContain("password = (set, hidden)");
  });

  it("warns when there is no password or key, and for a privileged container", async () => {
    open();
    await ready();
    fireEvent.click(screen.getByRole("switch", { name: "Unprivileged container" }));
    step(/Confirm/);
    expect(await screen.findByText(/A privileged container shares more/)).toBeTruthy();
    expect(screen.getByText(/No password or SSH key/)).toBeTruthy();
  });

  it("only offers keyctl to unprivileged containers", async () => {
    open();
    await ready();
    step(/DNS and features/);
    expect((screen.getByRole("switch", { name: "keyctl" }) as HTMLButtonElement).disabled).toBe(false);
    step(/General/);
    fireEvent.click(screen.getByRole("switch", { name: "Unprivileged container" }));
    step(/DNS and features/);
    expect((screen.getByRole("switch", { name: "keyctl" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Create virtual machine (demo)", () => {
  it("has the ten steps", async () => {
    open("?kind=vm");
    await ready();
    expect(steps().getAllByRole("button").map((b) => b.textContent!.replace(/^\d+/, "").trim())).toEqual(["General", "OS", "System", "Disks", "CPU", "Memory", "Network", "Cloud-init", "Hardware", "Confirm"]);
  });

  it("creates a virtual machine with its disks, CPU and memory", async () => {
    open("?kind=vm");
    await ready();
    type(field("Name"), "vm-demo");
    step(/Disks/);
    fireEvent.click(screen.getByRole("button", { name: "Add disk" }));
    type(screen.getAllByLabelText("Disk size")[1], "100");
    step(/CPU/);
    type(field("Cores"), "4");
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: "Create and start" }));
    await waitFor(() => expect(createVm).toHaveBeenCalled());
    expect(createVm.mock.calls[0][0]).toMatchObject({ name: "vm-demo", cores: 4, memoryMb: 2048, diskGb: 132, ostype: "l26", iso: "local:iso/debian-12.iso" });
  });

  it("moves to Windows 11's hardware when a Windows ISO is picked, and shows what changed", async () => {
    open("?kind=vm");
    await ready();
    step(/OS/);
    type(field("ISO image"), "local:iso/win11.iso");
    expect(field("Guest operating system").value).toBe("win11");
    expect(screen.getByText(/UEFI, a TPM 2.0, SATA and e1000e/)).toBeTruthy();
    step(/System/);
    expect(screen.getByText("Add an EFI disk")).toBeTruthy();
    expect(screen.getByLabelText("TPM storage")).toBeTruthy();
    step(/Disks/);
    expect(field("Bus").value).toBe("sata");
    step(/Network/);
    expect(field("Model").value).toBe("e1000e");
  });

  it("switches off disk options the bus can't do", async () => {
    open("?kind=vm");
    await ready();
    step(/Disks/);
    expect((screen.getByRole("switch", { name: "IO thread" }) as HTMLButtonElement).disabled).toBe(false);
    type(field("Bus"), "sata");
    const io = screen.getByRole("switch", { name: "IO thread" }) as HTMLButtonElement;
    expect(io.disabled).toBe(true);
    expect(io.getAttribute("aria-checked")).toBe("false");
    type(field("Bus"), "virtio");
    expect((screen.getByRole("switch", { name: "SSD emulation" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers a format only on file storage", async () => {
    open("?kind=vm");
    await ready();
    step(/Disks/);
    expect(screen.queryByLabelText("Format")).toBeNull();
    type(field("Storage"), "nas");
    expect(screen.getByLabelText("Format")).toBeTruthy();
  });

  it("shows ballooning's minimum only when ballooning is on", async () => {
    open("?kind=vm");
    await ready();
    step(/Memory/);
    expect(screen.queryByLabelText("Minimum memory")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Ballooning" }));
    expect(field("Minimum memory").value).toBe("1024");
    type(field("Minimum memory"), "4096");
    expect((await screen.findAllByText(/Minimum memory must be a whole number from 16 to 2048/)).length).toBeGreaterThan(0);
  });

  it("adds cloud-init with write-only secrets", async () => {
    open("?kind=vm");
    await ready();
    step(/Cloud-init/);
    fireEvent.click(screen.getByRole("switch", { name: "Add a cloud-init drive" }));
    type(field("User"), "deploy");
    const pw = field("Password");
    expect(pw.type).toBe("password");
    type(pw, "s3cret-pass-1");
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: /What will be sent to Proxmox/ }));
    const sent = (await screen.findByLabelText("Proxmox request")).textContent!;
    expect(sent).toContain("ide0 = local-lvm:cloudinit");
    expect(sent).toContain("ciuser = deploy");
    expect(sent).toContain("cipassword = (set, hidden)");
    expect(document.body.textContent).not.toContain("s3cret-pass-1");
  });

  it("adds PCI and USB passthrough, a serial port and audio", async () => {
    open("?kind=vm");
    await ready();
    step(/System/);
    type(field("Machine type"), "q35");
    step(/Hardware/);
    fireEvent.click(screen.getByRole("button", { name: "Add PCI device" }));
    type(field("Device"), "0000:01:00.0");
    expect((screen.getByRole("switch", { name: "PCI-Express" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Add USB device" }));
    type(screen.getAllByLabelText("Device")[1], "0bda:0041");
    type(field("Serial ports"), "2");
    fireEvent.click(screen.getByRole("switch", { name: "Audio device" }));
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: /What will be sent to Proxmox/ }));
    const sent = (await screen.findByLabelText("Proxmox request")).textContent!;
    expect(sent).toContain("hostpci0 = host=0000:01:00.0");
    expect(sent).toContain("usb0 = host=0bda:0041");
    expect(sent).toContain("serial1 = socket");
    expect(sent).toContain("audio0 = device=ich9-intel-hda,driver=spice");
  });

  it("explains PCIe needs q35", async () => {
    open("?kind=vm");
    await ready();
    step(/Hardware/);
    fireEvent.click(screen.getByRole("button", { name: "Add PCI device" }));
    expect((screen.getByRole("switch", { name: "PCI-Express" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Needs the q35 machine type/)).toBeTruthy();
  });

  it("keeps a machine in an organization inside its resource group", async () => {
    open("?kind=vm");
    await ready();
    type(field("Owner"), "acme");
    step(/Confirm/);
    expect((await screen.findAllByText(/Only 20 GB of disk left in this organization's resource group/)).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Create and start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a taken name in the demo", async () => {
    open("?kind=vm");
    await ready();
    type(field("Name"), "vm-lab");
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: "Create and start" }));
    expect(await screen.findByText(/A machine with that name exists/)).toBeTruthy();
    expect(createVm).not.toHaveBeenCalled();
  });
});

describe("live mode", () => {
  const liveOptions = {
    nextid: 300, node: "pve",
    templates: [{ volid: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", name: "debian-12", size: null }], isos: [{ volid: "local:iso/debian-12.iso", name: "debian-12.iso", size: null }],
    vmStorages: [{ storage: "local-lvm", type: "lvmthin", avail: 1e11, formats: ["raw"] }], ctStorages: [{ storage: "local-lvm", type: "lvmthin", avail: 1e11, formats: ["raw"] }],
    pools: [], bridges: [{ id: "vmbr0", kind: "bridge" }, { id: "vmbr1", kind: "bridge" }], cpuTypes: { common: ["x86-64-v2-AES", "host"], custom: ["custom-lab"], host: [] }, machines: ["pc-q35-9.0"],
    rawPassthrough: false, pci: [], usb: [], pciMappings: [{ id: "gpu0", description: "Main GPU" }], usbMappings: [], isAdmin: false, notes: [],
  };
  const calls: { url: string; method: string; body?: any }[] = [];
  beforeEach(() => {
    state.live = true;
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method: init?.method ?? "GET", body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/wizard/options") return json(liveOptions);
      if (url.startsWith("/api/wizard/vmid")) return json({ free: url.endsWith("=555"), message: "#101 is already used by another machine" });
      if (url === "/api/wizard/preview") return json({ vmid: 300, params: { name: "x", password: "(set, hidden)" }, warnings: [] });
      if (url === "/api/wizard/create") return json({ vmid: 300, task: "UPID:pve:1", warnings: [] }, 202);
      return json({ error: "no" }, 404);
    });
  });

  it("uses what the device offers: bridges, custom CPU models, mappings but no raw passthrough", async () => {
    open("?kind=vm");
    await ready();
    step(/Network/);
    expect(within(field("Bridge")).getAllByRole("option").map((o) => o.textContent)).toEqual(["vmbr0", "vmbr1"]);
    step(/CPU/);
    expect(within(field("CPU type")).getByRole("option", { name: "custom-lab" })).toBeTruthy();
    step(/Hardware/);
    expect(screen.getByText(/only root@pam can pass a raw device|only root@pam/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add PCI device" }));
    expect(within(field("Mapping")).getByRole("option", { name: "gpu0 · Main GPU" })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Raw device" })).toBeNull();
  });

  it("checks a typed machine number with the device", async () => {
    open("?kind=vm");
    await ready();
    type(field("Machine number"), "101");
    expect(await screen.findByText("#101 is already used by another machine")).toBeTruthy();
  });

  it("sends the request to the host, watches the task and keeps the password out of the page", async () => {
    open();
    await ready();
    type(field("Hostname"), "ct-live");
    type(field("Root password"), "correct-horse-battery");
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: /What will be sent to Proxmox/ }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/wizard/preview")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
    await waitFor(() => expect(watchTask).toHaveBeenCalledWith("UPID:pve:1", "Create container ct-live"));
    const post = calls.find((c) => c.url === "/api/wizard/create")!;
    expect(post.method).toBe("POST");
    expect(post.body.kind).toBe("ct");
    expect(post.body.spec.general).toMatchObject({ hostname: "ct-live", password: "correct-horse-battery", unprivileged: true });
    expect(post.body.spec.network[0]).toMatchObject({ bridge: "vmbr0", ipv4: { mode: "dhcp" } });
    expect(document.body.textContent).not.toContain("correct-horse-battery");
    expect(createMachine).not.toHaveBeenCalled();
  });

  it("shows Proxmox's own reason when the host refuses, and keeps the form", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url === "/api/wizard/options") return json(liveOptions);
      if (url === "/api/wizard/create") return json({ error: "unable to create VM 300: storage 'local-lvm' is full", code: "proxmox_rejected" }, 400);
      return json({ vmid: 300, params: {}, warnings: [] });
    });
    open("?kind=vm");
    await ready();
    type(field("Name"), "vm-live");
    step(/Confirm/);
    fireEvent.click(await screen.findByRole("button", { name: "Create and start" }));
    expect((await screen.findAllByText(/storage 'local-lvm' is full/)).length).toBeGreaterThan(0);
    expect(watchTask).not.toHaveBeenCalled();
    step(/General/);
    expect(field("Name").value).toBe("vm-live");
  });

  it("says so and offers a retry when the device can't answer", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Proxmox is not answering" }), { status: 502, headers: { "Content-Type": "application/json" } }));
    open();
    expect(await screen.findByText("Proxmox is not answering")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
