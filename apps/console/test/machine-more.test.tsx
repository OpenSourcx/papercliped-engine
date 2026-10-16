// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { demoBackend } from "../src/data/backend.ts";
import { demoData } from "../src/data/demo.ts";

const data = demoData(null);
const ct = data.guests.find((g) => g.type === "lxc" && g.status === "running")!;
const vm = data.guests.find((g) => g.type === "qemu" && g.status === "running") ?? data.guests.find((g) => g.type === "qemu")!;
const watchTask = vi.fn();
const notify = vi.fn();
let guests = data.guests;
let backend = demoBackend(() => data.host.storage, () => guests);
const cloneMachine = vi.fn(async () => ({ ok: true as const, vmid: 777 }));

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live: false,
    ready: true,
    resetAll: vi.fn(),
    watchTask,
    guestPower: vi.fn(() => ({ ok: true })),
    notify,
    cloneMachine,
    destroyMachine: vi.fn(async () => ({ ok: true })),
    contentVersion: 0,
    setup: { deviceName: "pve", pinMode: "assistant", pinAccess: {} },
    host: { uptimeSec: 100_000, ip: "192.168.1.10", cpuModel: "CPU", cpus: 4, memTotal: 8e9 },
    data: { ...data, guests },
    backend,
    changeHardware: async () => ({ ok: true }),
  }),
}));
vi.mock("../src/pin/PinContext.tsx", () => ({ usePin: () => ({ send: vi.fn(), setMode: vi.fn() }), usePinActions: () => undefined }));
vi.mock("../src/auth/session.tsx", () => ({ useSession: () => ({ session: { mode: "demo", user: { username: "sam@pve" } }, signOut: vi.fn() }) }));
vi.mock("../src/ui/UsageGraphs.tsx", () => ({ UsageGraphs: () => <div /> }));
vi.mock("../src/terminal/LazyTerminal.tsx", () => ({ Terminal: () => <div /> }));

import { MachinePage } from "../src/pages/machines/MachinePage.tsx";
import { Machines } from "../src/pages/machines/Machines.tsx";
import { Hardware } from "../src/pages/machines/Hardware.tsx";
import { CloneModal } from "../src/pages/machines/MachineClone.tsx";
import { CpuModelsPage } from "../src/pages/machines/CpuModels.tsx";

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const page = (path: string, ui: React.ReactElement, pattern: string) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /><Route path="*" element={<p>elsewhere</p>} /></Routes></MemoryRouter>);
const machine = (g: { vmid: number }, tab = "") => page(`/pve/machines/${g.vmid}${tab ? `?tab=${tab}` : ""}`, <MachinePage />, "/pve/machines/:vmid");
const hardware = (g: typeof vm) => page(`/pve/machines/${g.vmid}`, <Hardware g={g} />, "/pve/machines/:vmid");
const dialog = async () => within(await screen.findByRole("dialog"));

beforeEach(() => {
  guests = data.guests.map((g) => ({ ...g }));
  backend = demoBackend(() => data.host.storage, () => guests);
  watchTask.mockClear();
  notify.mockClear();
  cloneMachine.mockClear();
});
afterEach(cleanup);

describe("hardware: processor, machine type, devices and options (GU-021 to GU-027, GU-046 to GU-048, GU-070 to GU-075)", () => {
  it("edits the CPU type and flags, including a Spectre mitigation, and shows them", async () => {
    hardware(vm);
    const card = (await screen.findByText("Processor details")).closest("div.relative") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    type(d.getByLabelText(/CPU type/), "x86-64-v2-AES");
    fireEvent.click(d.getByRole("button", { name: /spec-ctrl/ }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByText("x86-64-v2-AES")).toBeTruthy());
    expect(within(card).getByText("+spec-ctrl")).toBeTruthy();
  });

  it("refuses more active CPUs than the VM has", async () => {
    hardware(vm);
    const card = (await screen.findByText("Processor details")).closest("div.relative") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    type(d.getByLabelText(/Active CPUs/), "999");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    expect((await d.findByRole("alert")).textContent).toMatch(/Active CPUs/);
  });

  it("sets the machine type and SCSI controller, and warns about the layout change", async () => {
    hardware(vm);
    const card = (await screen.findByText("Machine type and memory details")).closest("div.relative") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Machine$/ }));
    const d = await dialog();
    type(d.getByLabelText(/^Machine type/), "q35");
    type(d.getByLabelText(/^SCSI controller/), "virtio-scsi-single");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    expect(await d.findByText(/changes the virtual hardware layout/)).toBeTruthy();
    await waitFor(() => expect(within(card).getByText("q35")).toBeTruthy());
    expect(within(card).getByText(/VirtIO SCSI single/)).toBeTruthy();
  });

  it("adds a random number generator and removes it again", async () => {
    hardware(vm);
    const card = (await screen.findByText("Other devices")).closest("div.relative") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Random number generator/ }));
    fireEvent.click((await dialog()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByText("/dev/urandom", { exact: false })).toBeTruthy());
    fireEvent.click(within(card).getByRole("button", { name: "Edit Random number generator" }));
    fireEvent.click((await dialog()).getByRole("button", { name: /Remove/ }));
    await waitFor(() => expect(within(card).queryByText("/dev/urandom", { exact: false })).toBeNull());
  });

  it("turns the USB tablet off in More options", async () => {
    hardware(vm);
    const card = (await screen.findByText("More options")).closest("div.relative") as HTMLElement;
    expect(within(card).getByText("USB tablet").nextElementSibling?.textContent).toBe("On");
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    fireEvent.click(d.getByRole("switch", { name: "USB tablet" }));
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByText("USB tablet").nextElementSibling?.textContent).toBe("Off"));
  });

  it("a container has console and terminal options, and says why privileges can't change", async () => {
    hardware(ct as typeof vm);
    const card = (await screen.findByText("Container options")).closest("div.relative") as HTMLElement;
    expect(within(card).getByText(/can't be changed/)).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const d = await dialog();
    type(d.getByLabelText(/Terminals/), "4");
    type(d.getByLabelText("Console mode"), "console");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(card).getByText("console")).toBeTruthy());
  });
});

describe("host devices (GU-042, GU-043, GU-059)", () => {
  it("removes a device after saying what happens", async () => {
    hardware(vm);
    fireEvent.click(await screen.findByRole("button", { name: /Add device/ }));
    let d = await dialog();
    fireEvent.click(d.getByRole("radio", { name: "USB device" }));
    fireEvent.click((await dialog()).getByRole("radio", { name: "SPICE" }));
    fireEvent.click((await dialog()).getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove usb0" }));
    d = await dialog();
    expect(d.getByText(/goes back to the host/)).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: /^Remove$/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove usb0" })).toBeNull());
  });

  it("a container gets a device node form that explains the root-only rule", async () => {
    hardware(ct as typeof vm);
    fireEvent.click(await screen.findByRole("button", { name: /Add device/ }));
    const d = await dialog();
    expect(d.getByText(/Proxmox lets only root@pam pass a host device node/)).toBeTruthy();
    expect(d.getByLabelText(/^Device path/)).toBeTruthy();
  });
});

describe("Cloud-Init (GU-060 to GU-064)", () => {
  it("adds the drive, sets a user and password (never shown again), and lists what the image lacks", async () => {
    machine(vm, "cloudinit");
    fireEvent.click(await screen.findByRole("button", { name: /Add Cloud-Init drive/ }));
    fireEvent.click((await dialog()).getByRole("button", { name: "Add drive" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    const d = await dialog();
    type(d.getByLabelText("User"), "ubuntu");
    type(d.getByLabelText(/^Password/), "correct horse battery");
    type(d.getByLabelText(/SSH public keys/), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA me@pc");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Set (hidden)")).toBeTruthy());
    expect(document.body.textContent).not.toContain("correct horse");
    expect(screen.getByText("The image is out of date")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Regenerate image/ }));
    await waitFor(() => expect(screen.queryByText("The image is out of date")).toBeNull());
  });

  it("refuses a bad address and shows the generated files", async () => {
    machine(vm, "cloudinit");
    fireEvent.click(await screen.findByRole("button", { name: /Add Cloud-Init drive/ }));
    fireEvent.click((await dialog()).getByRole("button", { name: "Add drive" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
    const d = await dialog();
    type(d.getAllByLabelText("IPv4")[0], "static");
    type(d.getByLabelText("Address with prefix"), "10.0.0.5");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    expect((await d.findByRole("alert")).textContent).toMatch(/prefix/);
    fireEvent.click(d.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: /Generated files/ }));
    expect(await screen.findByText(/#cloud-config/)).toBeTruthy();
  });

  it("removing the drive needs its slot typed", async () => {
    machine(vm, "cloudinit");
    fireEvent.click(await screen.findByRole("button", { name: /Add Cloud-Init drive/ }));
    fireEvent.click((await dialog()).getByRole("button", { name: "Add drive" }));
    fireEvent.click(await screen.findByRole("button", { name: /Remove the Cloud-Init drive/ }));
    const d = await dialog();
    const go = d.getByRole("button", { name: "Remove drive" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(d.getByRole("textbox"), "ide0");
    fireEvent.click(go);
    expect(await screen.findByRole("button", { name: /Add Cloud-Init drive/ })).toBeTruthy();
  });

  it("is only a tab on virtual machines", async () => {
    machine(ct);
    await screen.findByRole("tab", { name: /Hardware/ });
    expect(screen.queryByRole("tab", { name: /Cloud-Init/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Guest agent/ })).toBeNull();
  });
});

describe("guest agent (GU-095, GU-096)", () => {
  it("shows the system and file systems, and freezing needs a typed word", async () => {
    machine(vm, "agent");
    expect(await screen.findByText("Ubuntu 24.04 LTS")).toBeTruthy();
    expect(await screen.findByText("/")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Freeze or thaw/ }));
    const d = await dialog();
    expect((d.getByRole("button", { name: "Freeze" }) as HTMLButtonElement).disabled).toBe(true);
    type(d.getByRole("textbox"), "freeze");
    fireEvent.click(d.getByRole("button", { name: "Freeze" }));
    expect(await d.findByText(/frozen/)).toBeTruthy();
  });

  it("running a command needs the word run, and sets a password without showing it", async () => {
    machine(vm, "agent");
    fireEvent.click(await screen.findByRole("button", { name: /Run a command/ }));
    let d = await dialog();
    const run = d.getByRole("button", { name: "Run" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    type(d.getByLabelText(/^Type/), "run");
    fireEvent.click(run);
    expect(await d.findByText(/Finished with exit code 0/)).toBeTruthy();
    fireEvent.click(d.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: /Set a user's password/ }));
    d = await dialog();
    type(d.getByLabelText(/User name/), "ubuntu");
    type(d.getByLabelText(/^New password/), "new-pass-123");
    fireEvent.click(d.getByRole("button", { name: "Set password" }));
    expect(await d.findByText(/Password changed for ubuntu/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("new-pass-123");
  });
});

describe("power, console, snapshots, clone and delete", () => {
  it("power options offer pause, hibernate and resume for a running VM", async () => {
    machine(vm);
    fireEvent.click(await screen.findByRole("button", { name: "Power options" }));
    const d = await dialog();
    const opts = within(d.getByLabelText("Action")).getAllByRole("option").map((o) => o.textContent);
    expect(opts.join(" ")).toMatch(/Pause[\s\S]*Hibernate[\s\S]*Resume/);
    type(d.getByLabelText("Action"), "hibernate");
    expect(d.getByText(/Saves the memory to disk/)).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Hibernate" }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
  });

  it("the console tab offers a SPICE file and the QEMU monitor", async () => {
    machine(vm, "console");
    fireEvent.click(await screen.findByRole("button", { name: /QEMU monitor/ }));
    const d = await dialog();
    type(d.getByLabelText("Monitor command"), "info status");
    fireEvent.click(d.getByRole("button", { name: "Run" }));
    expect(await d.findByText(/VM status: running/)).toBeTruthy();
  });

  it("snapshots: edit a description, and roll back only after the name is typed", async () => {
    const g = guests.find((x) => (x.snapshots?.length ?? 0) > 0) ?? vm;
    machine(g, "snapshots");
    const snaps = await backend.snapshots(g.vmid);
    const first = snaps.snapshots[0];
    fireEvent.click(await screen.findByRole("button", { name: `Edit description of snapshot ${first.name}` }));
    let d = await dialog();
    type(d.getByLabelText("Description"), "Before the upgrade");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getAllByRole("button", { name: /Roll back/ })[0]);
    d = await dialog();
    const go = d.getByRole("button", { name: "Roll back" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(d.getByText(/Start it afterwards/)).toBeTruthy();
    type(d.getByRole("textbox"), first.name);
    expect(go.disabled).toBe(false);
  });

  it("clone has More options and a Cloud-Init section for VMs, and sends the new machine on to its page", async () => {
    window.history.replaceState(null, "", `/pve/machines/${vm.vmid}?modal=clone&vmid=${vm.vmid}`);
    page(`/pve/machines/${vm.vmid}?modal=clone&vmid=${vm.vmid}`, <CloneModal onClose={() => undefined} />, "/pve/machines/:vmid");
    const d = await dialog();
    expect(await d.findByText("More options")).toBeTruthy();
    fireEvent.click(d.getByRole("switch", { name: "Set it up with Cloud-Init" }));
    type(d.getByLabelText("User"), "ubuntu");
    fireEvent.click(d.getByRole("button", { name: /^Clone$/ }));
    await waitFor(() => expect(cloneMachine).toHaveBeenCalled());
  });

  it("the machines list can select machines and asks for the count before shutting them down", async () => {
    page("/pve/machines", <Machines />, "/pve/machines");
    fireEvent.click(screen.getByRole("button", { name: /^Select$/ }));
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    const bar = screen.getByRole("region", { name: /Actions for the selected machines/ });
    expect(within(bar).getByText("1 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: /Shut down/ }));
    const d = await dialog();
    const go = d.getByRole("button", { name: "Shut down" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    type(d.getByLabelText(/Type/), "1");
    expect(go.disabled).toBe(false);
  });

  it("the machines list filters by kind and tag", async () => {
    page("/pve/machines", <Machines />, "/pve/machines");
    type(screen.getByLabelText("Show kind of machine"), "lxc");
    const shown = screen.getAllByRole("button", { name: /^Manage / }).length;
    expect(shown).toBe(guests.filter((g) => g.type === "lxc" && !g.template).length);
  });
});

describe("CPU models (DC-028, ND-059)", () => {
  it("adds a custom model on top of a base model, and lists what the device supports", async () => {
    render(<MemoryRouter><CpuModelsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Add a model/ }));
    const d = await dialog();
    type(d.getByLabelText(/^Name/), "fast");
    type(d.getByLabelText(/^Based on/), "Skylake-Server");
    type(d.getByLabelText(/^Flags/), "+aes;-pcid");
    fireEvent.click(d.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("custom-fast")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /What this device supports/ }));
    expect(await screen.findByText("spec-ctrl")).toBeTruthy();
    expect(screen.getByText("custom-fast")).toBeTruthy();
  });
});
