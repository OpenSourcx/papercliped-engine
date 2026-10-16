import { afterEach, describe, expect, it } from "vitest";
import { Harness } from "./diskcluster-harness.ts";
import { PEER_TOKEN_SECRET } from "./fakes-diskcluster.ts";

const h = new Harness();
afterEach(() => h.close());

describe("permissions", () => {
  it("needs sign-in and the same-site header; an unprivileged account can read but not change", async () => {
    await h.boot();
    expect((await h.send("", "GET", "/api/cluster/ceph/crush")).status).toBe(401);
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/start", { service: "ceph.target" }, {})).status).toBe(403);
    const lee = await h.signIn("lee");
    const r = await h.send(lee, "POST", "/api/cluster/ceph/service/start", { service: "ceph.target" });
    expect(r.status).toBe(403);
    expect(r.json.error).toMatch(/permission/);
    expect((await h.send(sam, "DELETE", "/api/cluster/ceph/crush")).status).toBe(405);
  });
});

describe("Ceph setup", () => {
  it("lists releases, gives the install command and writes the first configuration only when typed", async () => {
    await h.boot();
    const sam = await h.signIn();
    const s = (await h.send(sam, "GET", "/api/cluster/ceph/setup")).json;
    expect(s.releases.map((r: any) => r.name)).toEqual(["squid", "reef"]);
    expect(s.installCommand).toBe("pveceph install --repository no-subscription --version squid");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/init", { network: "10.0.0.0/24" })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/init", { network: "10.0.0.0/99", confirm: "ceph" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/init", { network: "10.0.0.0/24", size: 2, minSize: 3, confirm: "ceph" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/init", { network: "10.0.0.0/24", disableCephx: true, confirm: "ceph" })).json.code).toBe("confirm");
    const ok = await h.send(sam, "POST", "/api/cluster/ceph/init", { network: "10.0.0.0/24", clusterNetwork: "10.1.0.0/24", size: 3, minSize: 2, confirm: "ceph" });
    expect(ok.status).toBe(200);
    expect(h.pve.ceph.inited).toBe(true);
  });
});

describe("Ceph OSDs", () => {
  it("creates an OSD only after the drive's name is typed, and refuses a drive that is in use", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "/dev/sdc" })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "sdc", confirm: "sdc" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "/dev/sdd", confirm: "sdd" })).json.code).toBe("in_use");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "/dev/sdc", dbDev: "/dev/sdc", confirm: "sdc" })).status).toBe(400);
    const ok = await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "/dev/sdc", encrypted: true, deviceClass: "hdd", perDevice: 1, confirm: "sdc" });
    expect(ok.status).toBe(200);
    expect(ok.json.task).toMatch(/^UPID:/);
    const sent = h.calls("POST", "/nodes/pve/ceph/osd")[0].params;
    expect(sent).toMatchObject({ dev: "/dev/sdc", encrypted: "1", "crush-device-class": "hdd", "osds-per-device": "1" });
  });

  it("destroys an OSD only when it is out and down, Ceph says it is safe, and its name is typed", async () => {
    await h.boot();
    const sam = await h.signIn();
    await h.send(sam, "POST", "/api/cluster/ceph/osds", { dev: "/dev/sdc", confirm: "sdc" });
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osd/0/destroy", { confirm: "osd.0" })).json.code).toBe("not_ready");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osd/3/destroy", {})).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/osd/9/destroy", { confirm: "osd.9" })).json.code).toBe("no_osd");
    h.pve.ceph.unsafe.add("osd.3");
    const unsafe = await h.send(sam, "POST", "/api/cluster/ceph/osd/3/destroy", { confirm: "osd.3" });
    expect(unsafe.status).toBe(409);
    expect(unsafe.json.code).toBe("unsafe");
    expect(unsafe.json.error).toMatch(/without a copy/);
    const ok = await h.send(sam, "POST", "/api/cluster/ceph/osd/3/destroy", { confirm: "osd.3", acknowledgeUnsafe: true, cleanup: true });
    expect(ok.status).toBe(200);
    expect(h.calls("DELETE", "/nodes/pve/ceph/osd/3")[0].params.cleanup).toBe("1");
  });
});

describe("Ceph pools, daemons, file systems and services", () => {
  it("deletes a pool only with its name typed, and a pool with data needs a second yes", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/pools/vm-pool/delete", {})).json.code).toBe("confirm");
    const data = await h.send(sam, "POST", "/api/cluster/ceph/pools/vm-pool/delete", { confirm: "vm-pool" });
    expect(data.json.code).toBe("has_data");
    const ok = await h.send(sam, "POST", "/api/cluster/ceph/pools/vm-pool/delete", { confirm: "vm-pool", acknowledgeData: true, removeStorages: true });
    expect(ok.status).toBe(200);
    expect(h.calls("DELETE", "/nodes/pve/ceph/pool/vm-pool")[0].params.remove_storages).toBe("1");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/pools/..%2Fx/delete", { confirm: "x" })).status).toBe(400);
  });

  it("creates monitors, managers and metadata servers, and destroys them only when typed and safe", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mon", { address: "not an ip" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mgr", { address: "10.0.0.2" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mon", { id: "pve3", address: "10.0.0.4" })).status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/ceph/mon/pve3")[0].params["mon-address"]).toBe("10.0.0.4");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mds", { hotStandby: true })).status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/ceph/mds/pve")[0].params.hotstandby).toBe("1");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mon/pve2/destroy", {})).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mon/pve2/destroy", { confirm: "mon.pve2" })).status).toBe(200);
    // The only manager takes its own yes.
    const mgr = await h.send(sam, "POST", "/api/cluster/ceph/mgr/pve/destroy", { confirm: "mgr.pve" });
    expect(mgr.json.code).toBe("last_manager");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mgr/pve/destroy", { confirm: "mgr.pve", acknowledgeUnsafe: true })).status).toBe(200);
    h.pve.ceph.unsafe.add("mds.pve");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/mds/pve/destroy", { confirm: "mds.pve" })).json.code).toBe("unsafe");
  });

  it("creates and destroys a CephFS file system; taking the pools along needs a second yes", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs", { name: "bad name" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs", { name: "files", pgNum: 4 })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs", { name: "files", pgNum: 64, addStorage: true })).status).toBe(200);
    expect(h.calls("POST", "/nodes/pve/ceph/fs/files")[0].params).toMatchObject({ pg_num: "64", "add-storage": "1" });
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs/files/destroy", {})).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs/files/destroy", { confirm: "files", removePools: true })).json.code).toBe("has_data");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/fs/files/destroy", { confirm: "files", removePools: true, acknowledgeData: true, removeStorages: true })).status).toBe(200);
    expect(h.calls("DELETE", "/nodes/pve/ceph/fs/files")[0].params).toMatchObject({ "remove-pools": "1", "remove-storages": "1" });
  });

  it("starts services freely, and stops or restarts them only when typed and safe", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/start", { service: "osd.1" })).status).toBe(200);
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/stop", { service: "osd.1" })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/stop", { service: "; rm -rf /", confirm: "x" })).status).toBe(400);
    h.pve.ceph.unsafe.add("osd.1");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/restart", { service: "osd.1", confirm: "osd.1" })).json.code).toBe("unsafe");
    expect((await h.send(sam, "POST", "/api/cluster/ceph/service/restart", { service: "osd.1", confirm: "osd.1", acknowledgeUnsafe: true })).status).toBe(200);
    expect(h.pve.ceph.services).toEqual(["start osd.1", "restart osd.1"]);
  });

  it("shows the CRUSH map with its rules", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/cluster/ceph/crush")).json;
    expect(r.text).toContain("rule replicated_rule");
    expect(r.summary.rules).toEqual([{ name: "replicated_rule", type: "replicated", steps: ["take default", "chooseleaf firstn 0 type host", "emit"] }]);
    expect(r.summary.devices).toBe(2);
    expect(r.summary.buckets).toBe(2);
  });

  it("says Ceph isn't set up instead of failing", async () => {
    await h.boot({ ceph: false });
    const sam = await h.signIn();
    const r = await h.send(sam, "GET", "/api/cluster/ceph/setup");
    expect(r.status).toBe(200);
    expect(r.json.installed).toBe(false);
  });
});

describe("the quorum device and corosync", () => {
  it("reads the quorum device and gives validated, copyable setup and removal commands", async () => {
    await h.boot();
    const sam = await h.signIn();
    const q = (await h.send(sam, "GET", "/api/cluster/qdevice")).json;
    expect(q).toMatchObject({ clustered: true, configured: false, nodes: 3, evenNodes: false });
    h.pve.qdevice.configured = true;
    expect((await h.send(sam, "GET", "/api/cluster/qdevice")).json.configured).toBe(true);
    const g = (await h.send(sam, "GET", "/api/cluster/qdevice/guide?address=10.0.0.9")).json;
    expect(g.steps.map((s: any) => s.command)).toContain("pvecm qdevice setup 10.0.0.9");
    expect((await h.send(sam, "GET", "/api/cluster/qdevice/guide")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/qdevice/guide?address=10.0.0.9;reboot")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/qdevice/guide?action=remove")).json.steps[0].command).toBe("pvecm qdevice remove");
  });

  it("guides corosync link changes and refuses anything but an address", async () => {
    await h.boot();
    const sam = await h.signIn();
    const g = (await h.send(sam, "GET", "/api/cluster/corosync/guide?action=add-link&address=10.2.0.5&link=1&node=pve2")).json;
    expect(g.steps.some((s: any) => s.command === "ring1_addr: 10.2.0.5")).toBe(true);
    expect(g.steps.some((s: any) => s.command === "mv /etc/pve/corosync.conf.new /etc/pve/corosync.conf")).toBe(true);
    expect((await h.send(sam, "GET", "/api/cluster/corosync/guide?action=add-link&address=1.1.1.1&link=9")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/corosync/guide?action=nope&address=1.1.1.1")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/corosync/guide?action=add-link&address=10.2.0.5&node=a;b")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/corosync/guide?action=expected-votes")).json.steps[0].command).toBe("pvecm expected 1");
  });
});

describe("remote migration", () => {
  const good = { host: "dc2.example.com", fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99", tokenId: "root@pam!move", tokenSecret: PEER_TOKEN_SECRET, targetStorage: "local-lvm", targetBridge: "vmbr0", confirm: "200" };

  it("describes what the machine uses and what blocks it", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/cluster/remote-migrate/200")).json;
    expect(r).toMatchObject({ vmid: 200, type: "qemu", bridges: ["vmbr0"], blockers: [], experimental: true });
    expect(r.storages).toContain("local-lvm");
    expect((await h.send(sam, "GET", "/api/cluster/remote-migrate/103")).json.blockers.join(" ")).toMatch(/high availability/);
    expect((await h.send(sam, "GET", "/api/cluster/remote-migrate/999")).status).toBe(404);
  });

  it("checks every field, needs the machine number typed, and builds the endpoint without echoing the secret", async () => {
    await h.boot();
    const sam = await h.signIn();
    for (const bad of [{ host: "bad host!" }, { fingerprint: "AA:BB" }, { tokenId: "no-realm" }, { tokenSecret: "x" }, { targetStorage: "" }, { targetBridge: "vm br" }, { port: 99999 }, { targetVmid: 5 }]) {
      expect((await h.send(sam, "POST", "/api/cluster/remote-migrate/200", { ...good, ...bad })).status).toBe(400);
    }
    expect((await h.send(sam, "POST", "/api/cluster/remote-migrate/200", { ...good, confirm: "" })).json.code).toBe("confirm");
    expect((await h.send(sam, "POST", "/api/cluster/remote-migrate/200", { ...good, delete: true })).json.code).toBe("confirm");
    const r = await h.send(sam, "POST", "/api/cluster/remote-migrate/200", { ...good, port: 8006, online: true, bwlimit: 50000, targetVmid: 400 });
    expect(r.status).toBe(200);
    expect(r.json.task).toMatch(/^UPID:/);
    const sent = h.pve.remote[0];
    expect(sent.params["target-endpoint"]).toBe(`apitoken=PVEAPIToken=root@pam!move=${PEER_TOKEN_SECRET},host=dc2.example.com,port=8006,fingerprint=${good.fingerprint}`);
    expect(sent.params).toMatchObject({ "target-storage": "local-lvm", "target-bridge": "vmbr0", "target-vmid": "400", online: "1", bwlimit: "50000" });
    expect(h.seen.join("")).not.toContain(PEER_TOKEN_SECRET);
  });

  it("deletes the original only when 'delete' is typed too, and refuses HA machines and templates", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = await h.send(sam, "POST", "/api/cluster/remote-migrate/200", { ...good, delete: true, confirmDelete: "delete" });
    expect(r.status).toBe(200);
    expect(h.pve.remote[0].params.delete).toBe("1");
    const ha = await h.send(sam, "POST", "/api/cluster/remote-migrate/103", { ...good, confirm: "103" });
    expect(ha.json.code).toBe("ha");
  });

  it("never lets the token secret out through an error", async () => {
    await h.boot({ leakyRemoteMigrate: true });
    const sam = await h.signIn();
    const r = await h.send(sam, "POST", "/api/cluster/remote-migrate/200", good);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(h.seen.join("")).not.toContain(PEER_TOKEN_SECRET);
  });
});

describe("cluster-wide resources", () => {
  it("summarizes nodes, memory, storage and machines across the cluster, counting shared storage once", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/cluster/resources")).json;
    expect(Array.isArray(r.resources)).toBe(true);
    expect(r.summary.guests.vms.total).toBeGreaterThan(0);
    expect((await h.send(sam, "GET", "/api/cluster/resources?type=bogus")).status).toBe(400);
    expect((await h.send(sam, "GET", "/api/cluster/resources?type=vm")).json.resources.every((x: any) => x.type === "qemu" || x.type === "lxc")).toBe(true);
  });
});

describe("routed SDN: controllers, EVPN zones, fabrics, prefix lists and route maps", () => {
  it("reads everything in one answer", async () => {
    await h.boot();
    const sam = await h.signIn();
    const r = (await h.send(sam, "GET", "/api/cluster/sdn")).json;
    expect(r.controllers.map((c: any) => c.controller)).toEqual(["bgp1"]);
    expect(r.evpnZones.map((z: any) => z.zone)).toEqual(["evz"]);
    expect(r.fabrics.map((x: any) => x.id)).toEqual(["fab1"]);
    expect(r.prefixLists[0].id).toBe("pl1");
    expect(r.routeMaps.length).toBe(1);
    expect(r.supported.fabrics).toBe(true);
  });

  it("creates controllers from checked input and edits them with the digest", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "x" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2" })).json.error).toMatch(/asn/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 65001 })).json.error).toMatch(/peers/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 99999999999, peers: "10.0.0.2" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 65001, peers: "10.0.0.2,nope" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 65001, peers: "10.0.0.2", sneaky: 1 })).json.error).toMatch(/Unknown field/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 65001, peers: "10.0.0.2,10.0.0.3", "route-map-in": "nope" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn2", asn: 65001, peers: "10.0.0.2,10.0.0.3", "route-map-in": "rm1" })).status).toBe(200);
    const digest = h.pve.sdn.controllers.get("evpn2")!.digest;
    expect((await h.send(sam, "PUT", "/api/cluster/sdn/controllers/evpn2", { asn: 65002 })).status).toBe(400);
    expect((await h.send(sam, "PUT", "/api/cluster/sdn/controllers/evpn2", { asn: 65002, digest: "0".repeat(40) })).status).toBeGreaterThanOrEqual(400);
    expect((await h.send(sam, "PUT", "/api/cluster/sdn/controllers/evpn2", { asn: 65002, "route-map-in": null, digest })).status).toBe(200);
    const put = h.calls("PUT", "/cluster/sdn/controllers/evpn2")[1].params;
    expect(put).toMatchObject({ asn: "65002", delete: "route-map-in", digest });
  });

  it("removes a controller only when typed, and not while a zone uses it", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/controllers/bgp1", {})).json.code).toBe("confirm");
    const used = await h.send(sam, "DELETE", "/api/cluster/sdn/controllers/bgp1", { confirm: "bgp1" });
    expect(used.json.code).toBe("in_use");
    expect(used.json.error).toContain("zone evz");
    await h.send(sam, "DELETE", "/api/cluster/sdn/evpn-zones/evz", { confirm: "evz" });
  });

  it("creates EVPN zones against a real controller and keeps the exit-node rules", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "Bad Zone" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", "vrf-vxlan": 5000 })).json.error).toMatch(/controller/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", controller: "nope", "vrf-vxlan": 5000 })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", controller: "bgp1", "vrf-vxlan": 0 })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", controller: "bgp1", "vrf-vxlan": 5000, exitnodes: ["pve"], "exitnodes-primary": "pve2" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", controller: "bgp1", "vrf-vxlan": 5000, exitnodes: ["pve", "nowhere"] })).status).toBe(404);
    const ok = await h.send(sam, "POST", "/api/cluster/sdn/evpn-zones", { zone: "evz2", controller: "bgp1", "vrf-vxlan": 5000, exitnodes: ["pve", "pve2"], "exitnodes-primary": "pve", "advertise-subnets": true });
    expect(ok.status).toBe(200);
    expect(h.calls("POST", "/cluster/sdn/zones")[0].params).toMatchObject({ zone: "evz2", type: "evpn", controller: "bgp1", "vrf-vxlan": "5000", exitnodes: "pve,pve2", "exitnodes-primary": "pve", "advertise-subnets": "1" });
    // A simple zone isn't editable as an EVPN zone.
    expect((await h.send(sam, "PUT", "/api/cluster/sdn/evpn-zones/simp", { mtu: 1450, digest: "0".repeat(40) })).json.code).toBe("not_evpn");
    // A zone with VNets can't go.
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/evpn-zones/evz", { confirm: "evz" })).json.code).toBe("in_use");
  });

  it("creates fabrics by protocol with their redistribution, and takes nodes in and out", async () => {
    await h.boot();
    const sam = await h.signIn();
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "wireguard" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", ip_prefix: "10.20.0.0/24" })).json.error).toMatch(/area/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", area: "x", ip_prefix: "10.20.0.0/24" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", area: "0" })).json.error).toMatch(/address range/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", area: "0", ip_prefix: "10.20.0.0/24", redistribute: [{ source: "ospf" }] })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", area: "0", ip_prefix: "10.20.0.0/24", route_filter: "nope" })).status).toBe(400);
    const ok = await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f2", protocol: "ospf", area: "0", ip_prefix: "10.20.0.0/24", route_filter: "pl1", redistribute: [{ source: "connected", "route-map": "rm1" }, { source: "static" }] });
    expect(ok.status).toBe(200);
    const sent = h.pve.calls.find((c) => c.method === "POST" && c.path === "/cluster/sdn/fabrics/fabric")!;
    expect(sent.body).toContain("redistribute=source%3Dconnected%2Croute-map%3Drm1");
    expect(sent.body).toContain("redistribute=source%3Dstatic");

    const node = await h.send(sam, "POST", "/api/cluster/sdn/fabrics/f2/nodes/pve", { ip: "10.20.0.1", interfaces: [{ name: "eth1", ip: "10.20.0.1/32", network_type: "point-to-point" }] });
    expect(node.status).toBe(200);
    expect(h.calls("POST", "/cluster/sdn/fabrics/node/f2")[0].body).toContain("interfaces=name%3Deth1%2Cip%3D10.20.0.1%2F32%2Cnetwork_type%3Dpoint-to-point");
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics/f2/nodes/pve2", { ip: "10.20.0.2", interfaces: [{ name: "eth1", hello_multiplier: 5 }] })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/fabrics/f2/nodes/nowhere", { ip: "10.20.0.2", interfaces: [{ name: "eth1" }] })).status).toBe(404);
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/fabrics/f2/nodes/pve", {})).json.code).toBe("confirm");
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/fabrics/f2/nodes/pve", { confirm: "pve" })).status).toBe(200);
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/fabrics/f2", { confirm: "f2" })).status).toBe(200);
  });

  it("keeps prefix lists and route maps that something points at", async () => {
    await h.boot();
    const sam = await h.signIn();
    await h.send(sam, "POST", "/api/cluster/sdn/fabrics", { id: "f3", protocol: "ospf", area: "0", ip_prefix: "10.30.0.0/24", route_filter: "pl1" });
    const used = await h.send(sam, "DELETE", "/api/cluster/sdn/prefix-lists/pl1", { confirm: "pl1" });
    expect(used.json.code).toBe("in_use");
    expect(used.json.error).toContain("fabric f3");
    expect((await h.send(sam, "POST", "/api/cluster/sdn/prefix-lists", { id: "pl2", entries: [{ action: "permit", prefix: "10.0.0.0/8", ge: 16, le: 8 }] })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/prefix-lists", { id: "pl2", entries: [{ action: "maybe", prefix: "10.0.0.0/8" }] })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/prefix-lists", { id: "pl2", entries: [{ action: "permit", prefix: "10.0.0.0/8", le: 24, seq: 5 }] })).status).toBe(200);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/prefix-lists/pl2/entries", { action: "deny", prefix: "0.0.0.0/0" })).json.error).toMatch(/sequence/);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/prefix-lists/pl2/entries", { action: "deny", prefix: "0.0.0.0/0", seq: 20 })).status).toBe(200);
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/prefix-lists/pl2/entries/20", {})).status).toBe(200);
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/prefix-lists/pl2", { confirm: "pl2" })).status).toBe(200);

    expect((await h.send(sam, "POST", "/api/cluster/sdn/route-maps/rm2/entries", { order: 10, action: "permit", match: [{ key: "bogus", value: "1" }] })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/route-maps/rm2/entries", { order: 70000, action: "permit" })).status).toBe(400);
    expect((await h.send(sam, "POST", "/api/cluster/sdn/route-maps/rm2/entries", { order: 10, action: "permit", match: [{ key: "vni", value: "4000" }], set: [{ key: "weight", value: "10" }] })).status).toBe(200);
    expect(h.calls("POST", "/cluster/sdn/route-maps/entries")[0].body).toContain("match=key%3Dvni%2Cvalue%3D4000");
    await h.send(sam, "POST", "/api/cluster/sdn/controllers", { type: "evpn", controller: "evpn3", asn: 65003, peers: "10.0.0.2", "route-map-out": "rm1" });
    const rm = await h.send(sam, "DELETE", "/api/cluster/sdn/route-maps/rm1/entries/10", { confirm: "rm1:10" });
    expect(rm.json.code).toBe("in_use");
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/route-maps/rm2/entries/10", { confirm: "wrong" })).json.code).toBe("confirm");
    expect((await h.send(sam, "DELETE", "/api/cluster/sdn/route-maps/rm2/entries/10", { confirm: "rm2:10" })).status).toBe(200);
  });

  it("says plainly when this Proxmox has no fabrics", async () => {
    await h.boot({ noFabrics: true });
    const sam = await h.signIn();
    const r = await h.send(sam, "GET", "/api/cluster/sdn");
    expect(r.status).toBe(200);
    expect(r.json.supported).toMatchObject({ fabrics: false, prefixLists: false, routeMaps: false, controllers: true });
    expect(r.json.fabrics).toEqual([]);
  });
});
