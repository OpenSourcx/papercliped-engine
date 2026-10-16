// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { demoBackend } from "../src/data/backend.ts";
import { demoData } from "../src/data/demo.ts";

const data = demoData(null);
const ct = data.guests.find((g) => g.type === "lxc" && g.status === "running")!;
const vm = data.guests.find((g) => g.type === "qemu" && g.status === "running") ?? data.guests.find((g) => g.type === "qemu")!;
const guestPower = vi.fn(() => ({ ok: true }));
const watchTask = vi.fn();
let guests = data.guests;
let live = false;
let backend = demoBackend(() => data.host.storage, () => guests);

vi.mock("../src/data/store.tsx", () => ({
  useEngine: () => ({
    live,
    ready: true,
    resetAll: vi.fn(),
    watchTask,
    guestPower,
    notify: vi.fn(),
    contentVersion: 0,
    setup: { deviceName: "pve", pinMode: "assistant", pinAccess: {} },
    host: { uptimeSec: 100_000, ip: "192.168.1.10", cpuModel: "CPU", cpus: 4, memTotal: 8e9 },
    data: { ...data, guests },
    backend,
    changeHardware: async () => ({ ok: true }),
  }),
}));
vi.mock("../src/pin/PinContext.tsx", () => ({ usePin: () => ({ send: vi.fn(), setMode: vi.fn() }), usePinActions: () => undefined }));
vi.mock("../src/auth/session.tsx", () => ({ useSession: () => ({ session: { mode: live ? "live" : "demo", user: { username: "sam@pve" } }, signOut: vi.fn() }) }));
vi.mock("../src/ui/UsageGraphs.tsx", () => ({ UsageGraphs: () => <div /> }));
vi.mock("../src/terminal/LazyTerminal.tsx", () => ({ Terminal: () => <div /> }));

import { MachinePage } from "../src/pages/machines/MachinePage.tsx";
import { Machines } from "../src/pages/machines/Machines.tsx";
import { Hardware } from "../src/pages/machines/Hardware.tsx";
import { NotFound } from "../src/pages/NotFound.tsx";
import { OrgRoute } from "../src/pages/org/live/common.tsx";
import { MachinePermissions } from "../src/pages/machines/MachinePermissions.tsx";
import { Apps } from "../src/pages/Apps.tsx";
import { Settings } from "../src/pages/Settings.tsx";

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const at = (path: string, ui: React.ReactElement, pattern = "/pve/machines/:vmid") => render(<MemoryRouter initialEntries={[path]}><Routes><Route path={pattern} element={ui} /><Route path="*" element={<p>elsewhere</p>} /></Routes></MemoryRouter>);

beforeEach(() => {
  live = false;
  guests = data.guests.map((g) => ({ ...g }));
  backend = demoBackend(() => data.host.storage, () => guests);
  guestPower.mockClear();
  watchTask.mockClear();
});
afterEach(cleanup);

describe("a machine's header", () => {
  it("has Start, Shut down and Console buttons on the page (QA-01)", async () => {
    guests[0] = { ...guests[0], status: "stopped" };
    const g = guests[0];
    at(`/pve/machines/${g.vmid}`, <MachinePage />);
    const group = await screen.findByRole("group", { name: `Power and console for ${g.name}` });
    const start = within(group).getByRole("button", { name: /Start/ });
    expect((within(group).getByRole("button", { name: /Console/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(group).queryByRole("button", { name: /Shut down/ })).toBeNull();
    fireEvent.click(start);
    expect(guestPower).toHaveBeenCalledWith(g.vmid, "start");
  });

  it("shuts a running machine down and opens its console", async () => {
    const g = guests.find((x) => x.status === "running" && !x.protected && !x.template)!;
    at(`/pve/machines/${g.vmid}`, <MachinePage />);
    const group = await screen.findByRole("group", { name: `Power and console for ${g.name}` });
    fireEvent.click(within(group).getByRole("button", { name: /Shut down/ }));
    expect(guestPower).toHaveBeenCalledWith(g.vmid, "shutdown");
    expect((within(group).getByRole("button", { name: /Console/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows tags, and no empty chip when the machine has no OS to name (QA-04)", async () => {
    guests[0] = { ...guests[0], os: "", tags: ["web", "prod"] };
    at(`/pve/machines/${guests[0].vmid}`, <MachinePage />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.getAllByText("web").length).toBeGreaterThan(0);
    for (const chip of document.querySelectorAll("span.rounded-full")) expect((chip.textContent ?? "").trim()).not.toBe("");
  });
});

describe("a machine that does not exist (QA-02)", () => {
  it("says so, with a way back, instead of waiting", async () => {
    at("/pve/machines/9999", <MachinePage />);
    expect(await screen.findByText("There is no machine #9999")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to machines" }).getAttribute("href")).toBe("/pve/machines");
  });
});

describe("unknown addresses (QA-03)", () => {
  it("say the page was not found, not that the engine is missing", () => {
    render(<MemoryRouter initialEntries={["/pve/nope"]}><Routes><Route path="/:device/:org" element={<OrgRoute />} /></Routes></MemoryRouter>);
    expect(screen.getByText("We couldn't find that page")).toBeTruthy();
    expect(screen.getByText(/Nothing lives at \/pve\/nope/)).toBeTruthy();
    expect(screen.queryByText(/engine/i)).toBeNull();
  });
  it("NotFound takes a title and body", () => {
    render(<MemoryRouter><NotFound title="Gone" body="It left." /></MemoryRouter>);
    expect(screen.getByText("Gone")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Home" })).toBeTruthy();
  });
});

describe("the machines list", () => {
  it("can create a machine, search and sort (QA-05), and has one tab stop per action (QA-13)", async () => {
    render(<MemoryRouter initialEntries={["/pve/machines"]}><Routes><Route path="/pve/machines" element={<Machines />} /></Routes></MemoryRouter>);
    expect(screen.getByRole("button", { name: /New machine/ })).toBeTruthy();
    const cards = () => screen.getAllByRole("button", { name: /^Manage / });
    expect(cards().length).toBe(guests.length);
    expect(screen.getAllByRole("button", { name: /^Console for / }).length).toBe(guests.length);
    expect(screen.queryAllByRole("link", { name: "Manage" }).length).toBe(0);
    type(screen.getByLabelText("Search machines"), guests[0].name.slice(0, 4));
    expect(cards().length).toBeLessThanOrEqual(guests.length);
    expect(screen.getAllByRole("button", { name: `Manage ${guests[0].name}` }).length).toBe(1);
    type(screen.getByLabelText("Search machines"), "zzzz-nothing");
    expect(screen.getByText("No machines match")).toBeTruthy();
    type(screen.getByLabelText("Search machines"), "");
    type(screen.getByLabelText("Sort machines"), "name");
    const names = cards().map((b) => b.getAttribute("aria-label")!.replace("Manage ", ""));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  });
});

describe("hardware: resources (QA-09)", () => {
  const saveButton = () => screen.getAllByRole("button", { name: /Save/ }).find((b) => b.closest("div")?.textContent?.includes("vCPU")) as HTMLButtonElement;
  it("accepts any amount of memory, in MiB or GiB, and refuses what is not whole MiB", async () => {
    at(`/pve/machines/${vm.vmid}`, <Hardware g={guests.find((g) => g.vmid === vm.vmid)!} />);
    const memory = (await screen.findByLabelText("Memory")) as HTMLInputElement;
    type(screen.getByLabelText("Memory unit"), "GiB");
    type(memory, "3");
    fireEvent.click(saveButton());
    await waitFor(async () => expect((await backend.hardware(vm.vmid)).memoryMb).toBe(3072));
    // The card starts over from what was saved (a new digest), so wait for a fresh field before typing again.
    await waitFor(() => expect(screen.getByLabelText("Memory")).not.toBe(memory));
    const fresh = screen.getByLabelText("Memory") as HTMLInputElement;
    expect(fresh.value).toBe("3");
    type(screen.getByLabelText("Memory unit"), "MiB");
    type(fresh, "1500");
    fireEvent.click(saveButton());
    await waitFor(async () => expect((await backend.hardware(vm.vmid)).memoryMb).toBe(1500));
    await waitFor(() => expect(screen.getByLabelText("Memory")).not.toBe(fresh));
    expect((screen.getByLabelText("Memory") as HTMLInputElement).value).toBe("1500");
    type(screen.getByLabelText("Memory unit"), "GiB");
    type(screen.getByLabelText("Memory"), "1.3333");
    expect(await screen.findByText(/whole number of MiB/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });
  it("refuses less than 16 MiB and more than the machine can address", async () => {
    at(`/pve/machines/${vm.vmid}`, <Hardware g={guests.find((g) => g.vmid === vm.vmid)!} />);
    const field = await screen.findByLabelText("Memory");
    type(screen.getByLabelText("Memory unit"), "MiB");
    type(field, "8");
    expect(await screen.findByText(/Use between 16 MiB and 4096 GiB/)).toBeTruthy();
  });
});

const card = (title: string) => async () => (await screen.findByText(title)).closest("div.relative") as HTMLElement;
const addInNetwork = async () => within(await card("Network devices")()).getByRole("button", { name: /Add/ });

describe("hardware: network devices (GU-038, GU-056)", () => {
  it("adds a VM network device with model, bridge, VLAN, MAC, firewall and rate limit", async () => {
    at(`/pve/machines/${vm.vmid}`, <Hardware g={guests.find((g) => g.vmid === vm.vmid)!} />);
    fireEvent.click(await addInNetwork());
    const dialog = await screen.findByRole("dialog");
    type(within(dialog).getByLabelText("Model"), "e1000e");
    type(within(dialog).getByLabelText("VLAN tag", { exact: false }), "30");
    type(within(dialog).getByLabelText(/Rate limit/), "12.5");
    fireEvent.click(within(dialog).getByText(/Show advanced settings/));
    type(within(dialog).getByLabelText("MAC address"), "02:11:22:33:44:55");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add device" }));
    expect(await screen.findByText("net1")).toBeTruthy();
    expect(screen.getByText(/e1000e/)).toBeTruthy();
    expect(screen.getByText(/02:11:22:33:44:55/)).toBeTruthy();
    expect(screen.getByText(/VLAN 30/)).toBeTruthy();
    expect(screen.getByText(/12.5 MB\/s/)).toBeTruthy();
  });

  it("shows the reason when the MAC address is a group address", async () => {
    at(`/pve/machines/${vm.vmid}`, <Hardware g={guests.find((g) => g.vmid === vm.vmid)!} />);
    fireEvent.click(await addInNetwork());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText(/Show advanced settings/));
    type(within(dialog).getByLabelText("MAC address"), "01:00:5e:00:00:01");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add device" }));
    expect(await within(dialog).findByText(/group address/)).toBeTruthy();
  });

  it("removes a device only after its name is typed", async () => {
    at(`/pve/machines/${vm.vmid}`, <Hardware g={guests.find((g) => g.vmid === vm.vmid)!} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Remove net0$/ }));
    const go = await screen.findByRole("button", { name: "Remove device" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    type(screen.getByLabelText("Type net0 to confirm"), "net0");
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByText("No network devices. This machine is offline.")).toBeTruthy());
  });

  it("gives a container static IPv4 and IPv6 addresses, DNS and features", async () => {
    at(`/pve/machines/${ct.vmid}`, <Hardware g={guests.find((g) => g.vmid === ct.vmid)!} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Edit eth0$/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "IPv4" })).getByRole("radio", { name: "Static" }));
    type(within(dialog).getByLabelText("Address"), "10.0.0.5/24");
    type(within(dialog).getByLabelText("Gateway"), "10.0.0.1");
    fireEvent.click(within(within(dialog).getByRole("radiogroup", { name: "IPv6" })).getByRole("radio", { name: "Static" }));
    type(within(dialog).getByLabelText("Address", { selector: "#nic-ip6" }), "fd00::5/64");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/10\.0\.0\.5\/24/)).toBeTruthy();
    expect(screen.getByText(/gateway 10\.0\.0\.1/)).toBeTruthy();
    expect(screen.getByText(/fd00::5\/64/)).toBeTruthy();
  });

  it("sets a container's DNS and uses the host's when emptied", async () => {
    at(`/pve/machines/${ct.vmid}`, <Hardware g={guests.find((g) => g.vmid === ct.vmid)!} />);
    expect(await screen.findByText("Uses this device's DNS settings.")).toBeTruthy();
    const card = screen.getByText("DNS").closest("div.relative") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: /Edit/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Set my own" }));
    type(within(dialog).getByLabelText("DNS server 1"), "1.1.1.1");
    type(within(dialog).getByLabelText("Search domains"), "lan, corp.example");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("1.1.1.1")).toBeTruthy();
    expect(screen.getByText("lan, corp.example")).toBeTruthy();
  });

  it("toggles container features and saves them", async () => {
    at(`/pve/machines/${ct.vmid}`, <Hardware g={guests.find((g) => g.vmid === ct.vmid)!} />);
    const fuse = await screen.findByRole("switch", { name: "FUSE" });
    expect(fuse.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(fuse);
    fireEvent.click(screen.getByRole("checkbox", { name: /NFS/ }));
    fireEvent.click(within(await card("Features")()).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "FUSE" }).getAttribute("aria-checked")).toBe("true"));
    expect((screen.getByRole("checkbox", { name: /NFS/ }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("hardware: firmware and devices", () => {
  it("adds an EFI disk and switches the BIOS to UEFI", async () => {
    const g = guests.find((x) => x.type === "qemu")!;
    at(`/pve/machines/${g.vmid}`, <Hardware g={g} />);
    const card = (await screen.findByText("Firmware and devices")).closest("div.relative") as HTMLElement;
    const efiRow = within(card).getByText("EFI disk").closest("div.flex") as HTMLElement;
    fireEvent.click(within(efiRow).getByRole("button", { name: /Add/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add EFI disk" }));
    await waitFor(() => expect(within(card).getByRole("button", { name: "Remove the EFI disk" })).toBeTruthy());
    expect(within(card).getByText(/UEFI \(OVMF\)/)).toBeTruthy();
  });

  it("removing a TPM needs the state's name typed", async () => {
    const g = guests.find((x) => x.type === "qemu" && x.vmid === vm.vmid)!;
    at(`/pve/machines/${g.vmid}`, <Hardware g={g} />);
    const card = (await screen.findByText("Firmware and devices")).closest("div.relative") as HTMLElement;
    const tpmRow = within(card).getByText("TPM").closest("div.flex") as HTMLElement;
    fireEvent.click(within(tpmRow).getByRole("button", { name: /Add/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Add TPM" }));
    fireEvent.click(await within(card).findByRole("button", { name: "Remove the TPM" }));
    const go = await screen.findByRole("button", { name: "Remove TPM" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    type(screen.getByLabelText("Type tpmstate0 to confirm"), "tpmstate0");
    fireEvent.click(go);
    await waitFor(() => expect(within(card).queryByRole("button", { name: "Remove the TPM" })).toBeNull());
  });

  it("shows host devices read only", async () => {
    const g = guests.find((x) => x.type === "qemu")!;
    at(`/pve/machines/${g.vmid}`, <Hardware g={g} />);
    fireEvent.click(await screen.findByRole("button", { name: /Host devices/ }));
    expect(await screen.findByText(/GA104/)).toBeTruthy();
    expect(screen.getByText(/YubiKey/)).toBeTruthy();
  });
});

describe("permissions", () => {
  it("grants a role and revokes it only after the name is typed", async () => {
    render(<MemoryRouter><MachinePermissions vmid={vm.vmid} name={vm.name} /></MemoryRouter>);
    expect(await screen.findByText(/Nothing is set on this machine itself/)).toBeTruthy();
    expect(screen.getByText("owner@pve")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Grant access/ }));
    const dialog = await screen.findByRole("dialog");
    type(within(dialog).getByLabelText("User"), "sam@pve");
    type(within(dialog).getByLabelText("Role"), "PVEVMAdmin");
    fireEvent.click(within(dialog).getByRole("button", { name: "Grant access" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke PVEVMAdmin from sam@pve" }));
    const go = await screen.findByRole("button", { name: "Revoke access" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    type(screen.getByLabelText("Type sam@pve to confirm"), "sam@pve");
    fireEvent.click(go);
    await waitFor(() => expect(screen.queryByText("PVEVMAdmin")).toBeNull());
  });
});

describe("settings that no longer describe the demo as the device (QA-10, QA-11)", () => {
  it("General does not call a live device's organizations demo data, and the reset is not styled as destructive", () => {
    live = true;
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(screen.queryByText(/demo data/i)).toBeNull();
    expect(screen.getByText(/kept on the device, not in this browser/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset this browser's settings" }).className).not.toMatch(/critical/);
  });
  it("the demo keeps its Start over button", () => {
    render(<MemoryRouter><Settings /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "Start over" })).toBeTruthy();
  });
  it("Connected apps on a live device shows the device's own address and its real apps, not demo sessions", async () => {
    live = true;
    vi.stubGlobal("fetch", async (input: string) => {
      const path = new URL(input, "http://pve.lan").pathname;
      const body = path === "/api/connect/overview" ? { mcpUrl: "https://pve.lan/mcp", issuer: "https://pve.lan", scopes: [{ id: "paperclip:read", label: "Read only", description: "Look." }, { id: "paperclip:control", label: "Full control", description: "Act." }], user: "sam@pve", canManageAll: false, orgs: [], fetchUrl: false, tools: [], grantDays: 90 } : path === "/api/connect/apps" ? { apps: [], scope: "mine" } : path === "/api/connect/activity" ? { calls: [], events: [] } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}><MemoryRouter><Apps /></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("https://pve.lan/mcp")).toBeTruthy();
    expect(await screen.findByText("No apps connected")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull(); // no demo "API only / Full / Agent only" switch
    vi.unstubAllGlobals();
  });
});
