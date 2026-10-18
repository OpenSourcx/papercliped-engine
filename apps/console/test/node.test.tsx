// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

let live = true;
vi.mock("../src/data/store.tsx", () => ({ useEngine: () => ({ live, setup: { deviceName: "pve" } }) }));
vi.mock("../src/terminal/LazyTerminal.tsx", () => ({ Terminal: () => <div>terminal</div> }));

import { CertificatesPage } from "../src/pages/node/Certificates.tsx";
import { ClusterPage, OptionsPage, TagsPage, TasksAllPage } from "../src/pages/node/Datacenter.tsx";
import { NotificationsPage } from "../src/pages/node/Notifications.tsx";
import { PowerPage } from "../src/pages/node/Power.tsx";
import { ServicesPage } from "../src/pages/node/Services.tsx";
import { NodeUpdatesPage } from "../src/pages/node/UpdatesPage.tsx";
import { NodeSwitcher, useSelectedNode } from "../src/pages/node/common.tsx";

interface Call { method: string; path: string; query: URLSearchParams; body: any }
let calls: Call[];
let handlers: Record<string, (c: Call) => unknown>;
let nodes: { node: string; online: boolean }[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const key = (method: string, path: string) => `${method} ${path}`;

beforeEach(() => {
  live = true;
  calls = [];
  nodes = [{ node: "pve", online: true }];
  handlers = {};
  localStorage.clear();
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://pve.lan");
    const call: Call = { method: init.method ?? "GET", path: url.pathname, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (call.path === "/api/node/nodes") return json({ local: "pve", nodes: nodes.map((n) => ({ ...n, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null })) });
    const h = handlers[key(call.method, call.path)];
    if (!h) return json({ error: "Not found" }, 404);
    const out = h(call);
    return out instanceof Response ? out : json(out);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactElement, url = "/pve/x") => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter></QueryClientProvider>);
const posted = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe("live only", () => {
  it("says so in the demo instead of showing invented data", async () => {
    live = false;
    wrap(<ServicesPage />);
    expect(await screen.findByText(/works on a connected device/)).toBeTruthy();
    expect(calls.filter((c) => c.path !== "/api/node/nodes")).toHaveLength(0);
  });
});

describe("services", () => {
  beforeEach(() => {
    handlers["GET /api/node/services"] = () => ({ node: "pve", services: [
      { service: "chrony", name: "chrony", description: "time", state: "running", activeState: "active", unitState: "enabled", canControl: true },
      { service: "sshd", name: "sshd", description: "ssh", state: "running", activeState: "active", unitState: "enabled", canControl: true },
      { service: "postfix", name: "postfix", description: "mail", state: "dead", activeState: "inactive", unitState: "enabled", canControl: true },
    ] });
    handlers["POST /api/node/services/chrony/restart"] = () => ({ task: "UPID:pve:1:1:1:srvrestart::sam@pve:" });
    handlers["POST /api/node/services/sshd/stop"] = () => ({ task: "UPID:pve:1:1:1:srvstop::sam@pve:" });
  });

  it("restarts an ordinary service after one confirmation", async () => {
    wrap(<ServicesPage />);
    fireEvent.click(await screen.findByLabelText("Restart chrony"));
    expect(posted("POST", "/api/node/services/chrony/restart")).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(posted("POST", "/api/node/services/chrony/restart")).toHaveLength(1));
    expect(await screen.findByText(/Restart sent to chrony/)).toBeTruthy();
  });

  it("makes you type the name before stopping a service the device depends on", async () => {
    wrap(<ServicesPage />);
    fireEvent.click(await screen.findByLabelText("Stop sshd"));
    const go = await screen.findByRole("button", { name: "Stop service" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ssh" } });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "sshd" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/node/services/sshd/stop")).toHaveLength(1));
    expect(posted("POST", "/api/node/services/sshd/stop")[0].body).toEqual({ confirm: "sshd" });
  });

  it("shows Proxmox's refusal in words", async () => {
    handlers["POST /api/node/services/chrony/restart"] = () => json({ error: "Your Proxmox account doesn't have permission for this" }, 403);
    wrap(<ServicesPage />);
    fireEvent.click(await screen.findByLabelText("Restart chrony"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Restart" }));
    expect(await screen.findByText(/doesn't have permission/)).toBeTruthy();
  });
});

describe("the node switcher", () => {
  function Probe() {
    const [n] = useSelectedNode();
    return <span data-testid="selected">{n ?? "local"}</span>;
  }
  it("stays out of the way on a single node", async () => {
    wrap(<><NodeSwitcher /><Probe /></>);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/node/nodes")).toBe(true));
    expect(screen.queryByLabelText("Node")).toBeNull();
  });

  it("appears with more than one node and moves the pages to the node you pick", async () => {
    nodes = [{ node: "pve", online: true }, { node: "pve2", online: true }];
    handlers["GET /api/node/services"] = (c) => ({ node: c.query.get("node") ?? "pve", services: [] });
    wrap(<><NodeSwitcher /><ServicesPage /><Probe /></>);
    const select = (await screen.findAllByLabelText("Node"))[0] as HTMLSelectElement;
    await waitFor(() => expect(calls.some((c) => c.path === "/api/node/services")).toBe(true));
    expect(calls.find((c) => c.path === "/api/node/services")!.query.has("node")).toBe(false);
    fireEvent.change(select, { target: { value: "pve2" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/node/services" && c.query.get("node") === "pve2")).toBe(true));
    expect(screen.getByTestId("selected").textContent).toBe("pve2");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Services");
    expect(screen.getByText(/running on pve2/)).toBeTruthy();
  });
});

describe("power", () => {
  beforeEach(() => {
    handlers["GET /api/node/power"] = () => ({ node: "pve", local: true, thisService: "pve", running: [{ vmid: 101, name: "web", type: "lxc" }, { vmid: 102, name: "db", type: "qemu" }], runningUnknown: false, wakeOnLan: "not set", others: [{ node: "pve2", online: false }] });
    handlers["GET /api/node/subscription"] = () => ({ node: "pve", status: "notfound", level: null, productName: null, message: "There is no subscription key", serverId: "SRV1", sockets: 1, nextDueDate: null, registered: null, checkedAt: null, url: null, keyLast4: null });
    handlers["POST /api/node/power"] = () => ({ ok: true, selfAffected: true });
    handlers["POST /api/node/wakeonlan"] = () => ({ ok: true, mac: "aa" });
    handlers["PUT /api/node/subscription"] = () => ({ ok: true });
  });

  it("lists what a reboot stops and needs the node name typed", async () => {
    wrap(<PowerPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Reboot…/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("web")).toBeTruthy();
    expect(within(dlg).getByText("db")).toBeTruthy();
    expect(within(dlg).getByText(/ePaperclip, its console and Pin go away/)).toBeTruthy();
    const go = within(dlg).getByRole("button", { name: "Reboot device" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "pve" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/node/power")).toHaveLength(1));
    expect(posted("POST", "/api/node/power")[0].body).toEqual({ command: "reboot", confirm: "pve" });
    expect(await screen.findByText(/Rebooting pve/)).toBeTruthy();
  });

  it("wakes an offline node and sets a subscription key without echoing it", async () => {
    wrap(<PowerPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Wake/ }));
    await waitFor(() => expect(posted("POST", "/api/node/wakeonlan")[0]?.body).toEqual({ node: "pve2" }));
    const key = await screen.findByLabelText(/Subscription key/);
    fireEvent.change(key, { target: { value: "pve2c-aabbccddee" } });
    fireEvent.click(screen.getByRole("button", { name: "Set key" }));
    await waitFor(() => expect(posted("PUT", "/api/node/subscription")).toHaveLength(1));
    await waitFor(() => expect((screen.getByLabelText(/Subscription key/) as HTMLInputElement).value).toBe(""));
    expect(document.body.textContent).not.toContain("aabbccddee");
  });
});

describe("updates and repositories", () => {
  beforeEach(() => {
    handlers["GET /api/node/updates"] = () => ({ node: "pve", packages: [{ package: "pve-manager", title: "manager", description: "", oldVersion: "9.0.3", version: "9.0.4", origin: "Proxmox", priority: "", section: "", arch: "all" }, { package: "proxmox-kernel-6.8.12-4-pve-signed", title: "kernel", description: "", oldVersion: null, version: "6.8.12-4", origin: "Proxmox", priority: "", section: "", arch: "amd64" }], listDenied: false, listError: null, version: "pve-manager/9.0.3", runningKernel: "6.8.12-3-pve", newestInstalledKernel: "6.8.12-4-pve", rebootRequired: true, kernelUpdatePending: true });
    handlers["GET /api/node/updates/changelog"] = (c) => ({ package: c.query.get("name"), version: c.query.get("version"), text: "pve-manager (9.0.4) fixes things" });
    handlers["POST /api/node/updates/refresh"] = () => ({ task: "UPID:pve:1:1:1:aptupdate::sam@pve:" });
    handlers["GET /api/node/tasks/UPID%3Apve%3A1%3A1%3A1%3Aaptupdate%3A%3Asam%40pve%3A"] = () => ({ node: "pve", status: "stopped", exitstatus: "OK", lines: ["Get:1 http://download.proxmox.com", "TASK OK"], next: 2, total: 2 });
    handlers["GET /api/node/repos"] = () => ({ node: "pve", digest: "d1", repositories: [{ path: "/etc/apt/sources.list.d/pve-enterprise.sources", fileType: "sources", index: 0, enabled: true, types: ["deb"], uris: ["https://enterprise.proxmox.com/debian/pve"], suites: ["trixie"], components: ["pve-enterprise"], comment: null, kind: "enterprise" }], infos: [], errors: [], standardRepos: [{ handle: "no-subscription", name: "No-Subscription", status: "missing" }], subscriptionStatus: "notfound", warnings: [{ id: "enterprise-no-subscription", tone: "warning", message: "The enterprise repository is on, but this node has no active subscription.", fix: "no-subscription" }] });
    handlers["POST /api/node/repos/no-subscription"] = () => ({ disabledEnterprise: 1, noSubscriptionEnabled: true });
  });

  it("lists upgradable packages, warns about the reboot and opens a changelog", async () => {
    wrap(<NodeUpdatesPage />);
    expect(await screen.findByText("Reboot required")).toBeTruthy();
    expect(screen.getByText(/2 packages have an update/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Changelog for pve-manager"));
    expect(await screen.findByText(/pve-manager \(9.0.4\) fixes things/)).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/node/updates/changelog")!.query.get("version")).toBe("9.0.4");
  });

  it("refreshes the index as a task and shows its log", async () => {
    wrap(<NodeUpdatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Refresh list/ }));
    expect(await screen.findByText(/TASK OK/)).toBeTruthy();
    expect(await screen.findByText("Finished")).toBeTruthy();
  });

  it("asks for a typed confirmation before the upgrade, and warns about the kernel", async () => {
    wrap(<NodeUpdatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Upgrade…/ }));
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText(/A new kernel is included/)).toBeTruthy();
    const go = within(dlg).getByRole("button", { name: "Open upgrade terminal" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "upgrade" } });
    fireEvent.click(go);
    expect(await screen.findByText("terminal")).toBeTruthy();
  });

  it("offers a one-click switch from the enterprise repository when there is no subscription", async () => {
    wrap(<NodeUpdatesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Repositories" }));
    expect(await screen.findByText(/no active subscription/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use no-subscription" }));
    await waitFor(() => expect(posted("POST", "/api/node/repos/no-subscription")).toHaveLength(1));
    expect(await screen.findByText(/no-subscription repository is on/)).toBeTruthy();
  });
});

describe("certificates", () => {
  beforeEach(() => {
    handlers["GET /api/node/certificates"] = () => ({ node: "pve", certificates: [{ filename: "pve-ssl.pem", subject: "CN=pve", issuer: "CN=Proxmox Virtual Environment", san: ["DNS:pve"], fingerprint: "AA:BB", notBefore: 1_700_000_000, notAfter: 1_900_000_000, daysLeft: 400, keyType: "rsaEncryption", keyBits: 2048, custom: false }], serving: { fingerprint: "AA:BB" } });
    handlers["POST /api/node/certificates/custom"] = () => ({ certificate: { filename: "pveproxy-ssl.pem", fingerprint: "CC:DD", subject: "CN=pve.example.com", issuer: "CN=x", notAfter: 1_900_000_000 }, tls: { reloaded: true, changed: true, fingerprint: "CC:DD" }, warnings: ["This certificate doesn't list 127.0.0.1 or localhost."] });
  });
  const PEM = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
  const KEY = "-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----";

  it("uploads a certificate, reports the reload and never shows the key again", async () => {
    wrap(<CertificatesPage />);
    expect(await screen.findByText("CN=pve")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Upload custom certificate…/ }));
    const dlg = await screen.findByRole("dialog");
    const go = within(dlg).getByRole("button", { name: "Upload certificate" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Certificate chain/), { target: { value: PEM } });
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByLabelText(/Private key/), { target: { value: KEY } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("POST", "/api/node/certificates/custom")).toHaveLength(1));
    expect(posted("POST", "/api/node/certificates/custom")[0].body).toEqual({ certificates: PEM, key: KEY });
    expect(await screen.findByText("Certificate uploaded")).toBeTruthy();
    expect(screen.getByText(/already serving it/)).toBeTruthy();
    expect(screen.getByText(/doesn't list 127.0.0.1/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("SECRETKEYBODY");
  });

  it("tells you when this page is still served with an older certificate and reloads on request", async () => {
    handlers["GET /api/node/certificates"] = () => ({ node: "pve", certificates: [{ filename: "pveproxy-ssl.pem", subject: "CN=new", issuer: "CN=x", san: [], fingerprint: "CC:DD", notBefore: 1, notAfter: 2, daysLeft: 30, keyType: null, keyBits: null, custom: true }], serving: { fingerprint: "AA:BB" } });
    handlers["POST /api/node/certificates/reload"] = () => ({ reloaded: true, changed: true });
    wrap(<CertificatesPage />);
    expect(await screen.findByText("ePaperclip is serving an older certificate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload now" }));
    await waitFor(() => expect(posted("POST", "/api/node/certificates/reload")).toHaveLength(1));
  });

  it("removes the custom certificate only with the phrase typed", async () => {
    handlers["GET /api/node/certificates"] = () => ({ node: "pve", certificates: [{ filename: "pveproxy-ssl.pem", subject: "CN=new", issuer: "CN=x", san: [], fingerprint: "CC:DD", notBefore: 1, notAfter: 2, daysLeft: 30, keyType: null, keyBits: null, custom: true }], serving: { fingerprint: "CC:DD" } });
    handlers["DELETE /api/node/certificates/custom"] = () => ({ ok: true, tls: null });
    wrap(<CertificatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Remove custom certificate…/ }));
    const dlg = await screen.findByRole("dialog");
    const go = within(dlg).getByRole("button", { name: "Remove certificate" }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole("textbox"), { target: { value: "remove certificate" } });
    fireEvent.click(go);
    await waitFor(() => expect(posted("DELETE", "/api/node/certificates/custom")[0]?.body).toEqual({ confirm: "remove certificate" }));
  });

  it("orders from the ACME tab only once an account and a domain are set", async () => {
    handlers["GET /api/node/acme"] = () => ({ node: "pve", accounts: [{ name: "default" }], directories: [], plugins: [{ id: "cf", type: "dns", api: "cf", nodes: null, disabled: false, validationDelay: 30, hasSettings: true, digest: "p" }], pluginsDenied: false, apis: ["cf"], challengeSchema: [], config: { account: "default", domains: [{ index: 0, domain: "pve.example.com", plugin: "cf", alias: null }], digest: "n1" }, configDenied: false });
    handlers["POST /api/node/acme/order"] = () => ({ task: "UPID:pve:2:1:1:acmenewcert::sam@pve:" });
    handlers["GET /api/node/tasks/UPID%3Apve%3A2%3A1%3A1%3Aacmenewcert%3A%3Asam%40pve%3A"] = () => ({ node: "pve", status: "stopped", exitstatus: "OK", lines: ["TASK OK"], next: 1, total: 1 });
    handlers["POST /api/node/certificates/reload"] = () => ({ reloaded: true, changed: true });
    wrap(<CertificatesPage />);
    fireEvent.click(await screen.findByRole("tab", { name: /ACME/ }));
    expect((await screen.findAllByText("cf")).length).toBeGreaterThan(0);
    expect(screen.getByText(/settings saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Order certificate/ }));
    await waitFor(() => expect(posted("POST", "/api/node/acme/order")).toHaveLength(1));
    // When the task ends the host service is asked to re-read the certificate it serves.
    await waitFor(() => expect(posted("POST", "/api/node/certificates/reload").length).toBeGreaterThan(0));
  });
});

describe("datacenter", () => {
  it("renders a single node and a cluster from the same summary", async () => {
    handlers["GET /api/node/cluster"] = () => ({ clustered: false, name: null, quorate: true, configVersion: null, version: "9.0.3", nodes: [{ name: "pve", online: true, local: true, ip: "10.0.0.2", level: null, cpu: 0.1, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000, guests: { running: 1, total: 2 } }], guests: { running: 1, total: 2 }, statusDenied: false });
    wrap(<ClusterPage />);
    expect(await screen.findByText("Single device")).toBeTruthy();
    expect(screen.queryByText(/Manage pve/)).toBeNull();
    cleanup();
    handlers["GET /api/node/cluster"] = () => ({ clustered: true, name: "lab", quorate: false, configVersion: 3, version: "9.0.3", nodes: [{ name: "pve", online: true, local: true, ip: "10.0.0.2", level: null, cpu: 0.1, maxcpu: 4, mem: 2e9, maxmem: 8e9, uptime: 5000, guests: { running: 1, total: 2 } }, { name: "pve2", online: false, local: false, ip: "10.0.0.3", level: null, cpu: null, maxcpu: null, mem: null, maxmem: null, uptime: null, guests: { running: 0, total: 0 } }], guests: { running: 1, total: 2 }, statusDenied: false });
    wrap(<ClusterPage />);
    expect(await screen.findByText("lab")).toBeTruthy();
    expect(screen.getByText("The datacenter has lost quorum")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Manage pve2" })).toBeTruthy();
  });

  it("builds the options form from Proxmox's definitions and saves only what changed", async () => {
    handlers["GET /api/node/datacenter/options"] = () => ({
      values: { keyboard: "en-us", "next-id": { lower: 100, upper: 999999 } },
      schema: {
        keyboard: { type: "string", description: "Default keyboard layout", enum: ["de", "en-us", "fr"] },
        language: { type: "string", description: "Default language", enum: ["de", "en"] },
        "next-id": { type: "string", description: "Machine number range", props: { lower: { type: "integer", description: "Lowest", min: 100, max: 999999999 }, upper: { type: "integer", description: "Highest", min: 100, max: 1000000000 } } },
        max_workers: { type: "integer", description: "Workers", min: 1 },
      },
    });
    handlers["PUT /api/node/datacenter/options"] = () => ({ ok: true });
    wrap(<OptionsPage />);
    const kb = (await screen.findByLabelText("Keyboard layout")) as HTMLSelectElement;
    expect(kb.value).toBe("en-us");
    expect([...kb.options].map((o) => o.value)).toEqual(["", "de", "en-us", "fr"]);
    expect((screen.getByLabelText("Lower") as HTMLInputElement).value).toBe("100");
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(kb, { target: { value: "fr" } });
    fireEvent.change(screen.getByLabelText("Upper"), { target: { value: "5000" } });
    fireEvent.click(save);
    await waitFor(() => expect(posted("PUT", "/api/node/datacenter/options")).toHaveLength(1));
    expect(posted("PUT", "/api/node/datacenter/options")[0].body).toEqual({ values: { keyboard: "fr", "next-id": { lower: 100, upper: 5000 } } });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("clears a setting by sending null", async () => {
    handlers["GET /api/node/datacenter/options"] = () => ({ values: { keyboard: "de" }, schema: { keyboard: { type: "string", description: "k", enum: ["de", "fr"] } } });
    handlers["PUT /api/node/datacenter/options"] = () => ({ ok: true });
    wrap(<OptionsPage />);
    fireEvent.change(await screen.findByLabelText("Keyboard layout"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posted("PUT", "/api/node/datacenter/options")[0]?.body).toEqual({ values: { keyboard: null } }));
  });

  it("shows tags with counts and saves a color", async () => {
    handlers["GET /api/node/datacenter/tags"] = () => ({ tags: [{ tag: "prod", count: 2, color: { background: "ff0000", foreground: null }, registered: true }], style: { shape: "full", ordering: "alphabetical", caseSensitive: false }, denied: false });
    handlers["PUT /api/node/datacenter/tags"] = () => ({ ok: true });
    wrap(<TagsPage />);
    expect(await screen.findByText("prod")).toBeTruthy();
    expect(screen.getByText("Protected")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Background for prod"), { target: { value: "#00ff00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("PUT", "/api/node/datacenter/tags")[0]?.body).toEqual({ colors: { prod: { background: "00ff00", foreground: null } } }));
  });
});

describe("notifications", () => {
  beforeEach(() => {
    const schemas = {
      sendmail: { mailto: { type: "array", description: "Recipients", items: { type: "string", description: "" } } },
      gotify: { server: { type: "string", description: "Server URL", required: true }, token: { type: "string", description: "Secret token", required: true, secret: true } },
      smtp: {}, webhook: {}, matcher: { mode: { type: "string", description: "mode", enum: ["all", "any"] } },
    };
    handlers["GET /api/node/datacenter/notifications"] = () => ({ targets: [{ name: "mail-to-root", type: "sendmail", comment: "", disabled: false, builtin: true }, { name: "ops", type: "gotify", comment: "", disabled: false, builtin: false }], matchers: [], denied: false, schemas });
    handlers["GET /api/node/datacenter/notifications/targets/gotify/ops"] = () => ({ name: "ops", type: "gotify", values: { server: "https://gotify.lan" }, digest: "g1", secretsSet: ["token"] });
    handlers["PUT /api/node/datacenter/notifications/targets/gotify/ops"] = () => ({ ok: true });
    handlers["POST /api/node/datacenter/notifications/targets/ops/test"] = () => ({ ok: true });
  });

  it("never shows a stored token, and replaces it only when a new one is typed", async () => {
    wrap(<NotificationsPage />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[0]);
    const token = (await screen.findByLabelText(/Token/)) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(token.type).toBe("password");
    expect(screen.getByText(/token is set and never shown/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save target" }));
    await waitFor(() => expect(posted("PUT", "/api/node/datacenter/notifications/targets/gotify/ops")).toHaveLength(1));
    expect(posted("PUT", "/api/node/datacenter/notifications/targets/gotify/ops")[0].body).toEqual({ values: {}, digest: "g1" });
  });

  it("sends a test and cannot edit or delete the built-in target", async () => {
    wrap(<NotificationsPage />);
    const row = (await screen.findByText("mail-to-root")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(row).queryByLabelText(/Delete/)).toBeNull();
    fireEvent.click(within(screen.getByText("ops").closest("tr")!).getByRole("button", { name: /Test/ }));
    expect(await screen.findByText(/Sent a test notification through ops/)).toBeTruthy();
  });
});

describe("tasks", () => {
  const rows = [
    { upid: "UPID:pve:1:1:1:vzdump::lee@pve:", node: "pve", type: "vzdump", id: null, user: "lee@pve", status: "backup failed", start: 1_700_000_000, end: 1_700_000_100 },
    { upid: "UPID:pve2:2:1:1:qmstart:101:sam@pve:", node: "pve2", type: "qmstart", id: "101", user: "sam@pve", status: null, start: 1_700_000_200, end: null },
  ];
  beforeEach(() => {
    handlers["GET /api/node/tasks"] = () => ({ tasks: rows });
    handlers["DELETE /api/node/tasks/UPID%3Apve2%3A2%3A1%3A1%3Aqmstart%3A101%3Asam%40pve%3A"] = () => ({ ok: true });
  });

  it("lists tasks across nodes, filters them and stops a running one", async () => {
    nodes = [{ node: "pve", online: true }, { node: "pve2", online: true }];
    wrap(<TasksAllPage />, "/pve/tasks/all?type=qmstart");
    expect(await screen.findByText("backup failed")).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/node/tasks")!.query.get("type")).toBe("qmstart");
    expect(screen.getAllByText("pve2").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "error" } });
    await waitFor(() => expect(calls.some((c) => c.path === "/api/node/tasks" && c.query.get("status") === "error")).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: /Stop qmstart task/ }));
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop task" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1));
  });

  it("opens a task's log from any node", async () => {
    handlers["GET /api/node/tasks/UPID%3Apve%3A1%3A1%3A1%3Avzdump%3A%3Alee%40pve%3A"] = () => ({ node: "pve", status: "stopped", exitstatus: "backup failed", lines: ["starting", "ERROR: backup failed"], next: 2, total: 2 });
    wrap(<TasksAllPage />);
    fireEvent.click(await screen.findByRole("button", { name: "vzdump" }));
    expect(await screen.findByText(/ERROR: backup failed/)).toBeTruthy();
    expect(screen.getByText("Ended: backup failed")).toBeTruthy();
  });
});
