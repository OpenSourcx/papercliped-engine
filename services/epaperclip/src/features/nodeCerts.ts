import { ProxmoxError, type ProxmoxClient } from "@papercliped-engine/proxmox-client";
import { HttpError } from "../http.ts";
import { bad, confirmed, guarded, noExtra, resolveNode, seg, soft, str, type Deps, type Route } from "./nodeCommon.ts";
import { SCHEMAS } from "./nodeSchema.ts";
import { checkCertificateChain, checkGroup, checkPrivateKey, configId, parseProps, scrub } from "./nodeValidate.ts";

/** Certificates and ACME. Replacing the node certificate changes what this service serves too: see nodeTls.ts. */

const CERT_BODY_MAX = 200_000;
const keyLines = (key: string) => key.split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));

const email = (v: string) => /^[^\s@,;<>"]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(v);
function contacts(v: unknown): string {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const items = list.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
  if (!items.length || items.length > 8 || !items.every(email)) return bad("Give one or more email addresses for the certificate authority to reach you");
  return items.join(",");
}
function httpsUrl(v: unknown): string {
  const s = str(v, 512);
  if (!s) return bad("Give the certificate authority's directory address");
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" || u.username || u.password || u.hash) throw new Error();
  } catch {
    return bad("The directory address must be an https address without a user name");
  }
  return s;
}

/** An ACME DNS plugin's settings, as KEY=value lines (they hold API tokens, so they are never read back). */
function pluginData(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 4096) return bad("The plugin settings are limited to 4 KB");
  const lines = v.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length || lines.length > 40 || !lines.every((l) => /^[A-Za-z_][A-Za-z0-9_]{0,63}=[^\u0000-\u001f]{0,1000}$/.test(l))) return bad("Plugin settings are lines such as CF_Token=value");
  return Buffer.from(`${lines.join("\n")}\n`).toString("base64");
}

export function certRoutes(d: Deps): Route[] {
  const tlsInfo = () => ({ fingerprint: d.tls.fingerprint });

  // After an order or renewal, wait for the task and then re-read the files. The file watcher also catches it.
  const afterTask = (pve: ProxmoxClient, node: string, upid: string) => {
    void (async () => {
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, d.pollMs));
        try {
          if ((await pve.taskStatus(node, upid)).status === "stopped") break;
        } catch {
          break;
        }
      }
      d.tls.reload();
      d.tls.reloadSoon();
    })();
  };

  const acmeConfig = (raw: Record<string, unknown>) => {
    const acme = parseProps(raw.acme);
    const domains = [0, 1, 2, 3, 4, 5].flatMap((i) => {
      const v = raw[`acmedomain${i}`];
      if (typeof v !== "string") return [];
      const p = parseProps(v);
      return p.domain ? [{ index: i, domain: p.domain, plugin: p.plugin ?? null, alias: p.alias ?? null }] : [];
    });
    return { account: acme.account ?? null, domains, digest: typeof raw.digest === "string" ? raw.digest : null };
  };

  return [
    {
      method: "GET",
      re: /^\/api\/node\/certificates$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const list = await pve.call<Record<string, any>[]>("GET", `/nodes/${seg(node)}/certificates/info`);
          const now = Math.floor(c.now() / 1000);
          const certificates = list.map((x) => ({ filename: x.filename ?? "", subject: x.subject ?? "", issuer: x.issuer ?? "", san: Array.isArray(x.san) ? x.san : [], fingerprint: x.fingerprint ?? "", notBefore: x.notbefore ?? null, notAfter: x.notafter ?? null, daysLeft: typeof x.notafter === "number" ? Math.floor((x.notafter - now) / 86400) : null, keyType: x["public-key-type"] ?? null, keyBits: x["public-key-bits"] ?? null, custom: x.filename === "pveproxy-ssl.pem" }));
          return { node, certificates, serving: node === c.node ? tlsInfo() : null };
        });
        c.json(200, out);
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/certificates\/custom$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson(CERT_BODY_MAX);
        noExtra(body, ["node", "certificates", "key"]);
        const chain = checkCertificateChain(body.certificates, c.now());
        const key = checkPrivateKey(body.key, chain);
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const info = await guarded(keyLines(key), () => pve.call<Record<string, any>>("POST", `/nodes/${seg(node)}/certificates/custom`, { certificates: chain.pem, key, force: true, restart: true }));
          const tls = node === c.node ? d.tls.reload() : null;
          if (node === c.node) d.tls.reloadSoon();
          return { node, info, tls };
        });
        const warnings: string[] = [];
        if (!chain.coversLoopback) warnings.push("This certificate doesn't list 127.0.0.1 or localhost. ePaperclip talks to Proxmox on this machine over https://127.0.0.1:8006, so it may stop reaching Proxmox until EPC_PVE_URL names this node (for example https://pve.example.com:8006). See docs/NODE.md.");
        if (chain.selfSigned) warnings.push("This certificate is self-signed, so browsers will warn about it.");
        c.json(200, { certificate: { filename: out.info.filename ?? "pveproxy-ssl.pem", fingerprint: out.info.fingerprint ?? chain.fingerprint256, subject: chain.subject, issuer: chain.issuer, san: chain.san, notAfter: Math.floor(chain.validTo / 1000) }, tls: out.tls, warnings });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/certificates\/custom$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "confirm"]);
        confirmed(body, "remove certificate", "removing the custom certificate");
        const tls = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("DELETE", `/nodes/${seg(node)}/certificates/custom`, { restart: true });
          return node === c.node ? (d.tls.reloadSoon(), d.tls.reload()) : null;
        });
        c.json(200, { ok: true, tls });
      },
    },
    {
      // Re-read this service's own certificate files now (no Proxmox call): the console uses it after a task ends.
      method: "POST",
      re: /^\/api\/node\/certificates\/reload$/,
      run: async (c) => {
        c.sameSite();
        await c.readJson();
        await c.asUser(async (pve) => {
          if (!(await c.isNodeAdmin(pve))) throw new HttpError(403, "forbidden", "Only Proxmox administrators (Sys.Modify on /) can reload the certificate");
        });
        c.json(200, d.tls.reload());
      },
    },

    // ---- ACME
    {
      method: "GET",
      re: /^\/api\/node\/acme$/,
      run: async (c) => {
        const out = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve);
          const [accounts, directories, plugins, schema, cfg] = await Promise.all([
            soft(pve.call<{ name: string }[]>("GET", "/cluster/acme/account")),
            soft(pve.call<{ name: string; url: string }[]>("GET", "/cluster/acme/directories")),
            soft(pve.call<Record<string, any>[]>("GET", "/cluster/acme/plugins")),
            soft(pve.call<{ id: string; name: string; type: string; schema: Record<string, any> }[]>("GET", "/cluster/acme/challenge-schema")),
            soft(pve.call<Record<string, unknown>>("GET", `/nodes/${seg(node)}/config`)),
          ]);
          return {
            node,
            accounts: (accounts.data ?? []).map((a) => ({ name: a.name })),
            directories: directories.data ?? [],
            // DNS plugin settings hold API tokens: only whether they are set is returned.
            plugins: plugins.denied ? null : (plugins.data ?? []).map((p) => ({ id: p.plugin, type: p.type, api: p.api ?? null, nodes: p.nodes ?? null, disabled: p.disable === 1 || p.disable === true, validationDelay: p["validation-delay"] ?? null, hasSettings: typeof p.data === "string" && p.data.length > 0, digest: p.digest ?? null })),
            pluginsDenied: plugins.denied,
            apis: SCHEMAS.acmePlugin.api?.enum ?? [],
            challengeSchema: (schema.data ?? []).map((s) => ({ id: s.id, name: s.name, type: s.type, fields: s.schema?.fields ?? s.schema ?? {} })),
            config: cfg.data ? acmeConfig(cfg.data) : null,
            configDenied: cfg.denied,
          };
        });
        c.json(200, out);
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/acme\/accounts\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        const name = configId(m[1]);
        const a = await c.asUser((pve) => pve.call<{ account?: Record<string, any>; directory?: string; tos?: string }>("GET", `/cluster/acme/account/${seg(name)}`));
        c.json(200, { name, directory: a.directory ?? null, tos: a.tos ?? null, status: a.account?.status ?? null, contact: Array.isArray(a.account?.contact) ? a.account.contact.map((x: string) => x.replace(/^mailto:/, "")) : [], createdAt: a.account?.createdAt ?? null });
      },
    },
    {
      method: "GET",
      re: /^\/api\/node\/acme\/tos$/,
      run: async (c) => {
        const dir = c.url.searchParams.get("directory");
        const directory = dir ? httpsUrl(dir) : undefined;
        const out = await c.asUser(async (pve) => ({ tos: await pve.call<string | null>("GET", "/cluster/acme/tos", { directory }), meta: await soft(pve.call<Record<string, unknown>>("GET", "/cluster/acme/meta", { directory })).then((r) => r.data) }));
        c.json(200, { tos: out.tos ?? null, externalAccountRequired: !!(out.meta as { externalAccountRequired?: unknown } | null)?.externalAccountRequired });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/acme\/accounts$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["name", "contact", "directory", "acceptTos", "eabKid", "eabHmacKey"]);
        const name = body.name === undefined || body.name === "" ? "default" : configId(body.name, "account name");
        const contact = contacts(body.contact);
        const directory = body.directory === undefined || body.directory === "" ? undefined : httpsUrl(body.directory);
        if (body.acceptTos !== true) bad("Accept the certificate authority's terms of service to register");
        const kid = body.eabKid === undefined || body.eabKid === "" ? undefined : str(body.eabKid, 256) ?? bad("Bad key identifier");
        const hmac = body.eabHmacKey === undefined || body.eabHmacKey === "" ? undefined : str(body.eabHmacKey, 1024) ?? bad("Bad HMAC key");
        if (!!kid !== !!hmac) bad("External account binding needs both the key identifier and the HMAC key");
        const task = await c.asUser(async (pve) => {
          const tos = await pve.call<string | null>("GET", "/cluster/acme/tos", { directory });
          return guarded([hmac], () => pve.call<string>("POST", "/cluster/acme/account", { name, contact, directory, tos_url: tos ?? undefined, "eab-kid": kid, "eab-hmac-key": hmac }));
        });
        c.json(202, { task });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/acme\/accounts\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["contact"]);
        const contact = contacts(body.contact);
        const task = await c.asUser((pve) => pve.call<string>("PUT", `/cluster/acme/account/${seg(configId(m[1]))}`, { contact }));
        c.json(202, { task });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/acme\/accounts\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const name = configId(m[1]);
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, name, `deleting the account ${name}`);
        const task = await c.asUser((pve) => pve.call<string>("DELETE", `/cluster/acme/account/${seg(name)}`));
        c.json(202, { task });
      },
    },
    {
      method: "POST",
      re: /^\/api\/node\/acme\/plugins$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["id", "type", "settings", "api", "nodes", "disable", "validation-delay"]);
        const id = configId(body.id, "plugin name");
        if (body.type !== "dns" && body.type !== "standalone") bad("A plugin type is dns or standalone");
        const data = pluginData(body.settings);
        if (body.type === "dns" && !body.api) bad("Pick the DNS provider");
        const { params } = checkGroup(SCHEMAS.acmePlugin, Object.fromEntries(Object.entries(body).filter(([k]) => ["api", "nodes", "disable", "validation-delay"].includes(k))), { creating: true });
        await c.asUser((pve) => guarded([data, String(body.settings ?? "")], () => pve.call("POST", "/cluster/acme/plugins", { id, type: body.type as string, ...params, data })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "PUT",
      re: /^\/api\/node\/acme\/plugins\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["settings", "api", "nodes", "disable", "validation-delay"]);
        const id = configId(m[1]);
        const data = pluginData(body.settings);
        const { params, remove } = checkGroup(SCHEMAS.acmePlugin, Object.fromEntries(Object.entries(body).filter(([k]) => k !== "settings")));
        await c.asUser((pve) => guarded([data, String(body.settings ?? "")], () => pve.call("PUT", `/cluster/acme/plugins/${seg(id)}`, { ...params, data, delete: remove.filter((k) => k !== "data").join(",") || undefined })));
        c.json(200, { ok: true });
      },
    },
    {
      method: "DELETE",
      re: /^\/api\/node\/acme\/plugins\/([A-Za-z][\w-]{1,63})$/,
      run: async (c, m) => {
        c.sameSite();
        const id = configId(m[1]);
        const body = await c.readJson();
        noExtra(body, ["confirm"]);
        confirmed(body, id, `deleting the plugin ${id}`);
        await c.asUser((pve) => pve.call("DELETE", `/cluster/acme/plugins/${seg(id)}`));
        c.json(200, { ok: true });
      },
    },
    {
      // Which account and domains this node orders its certificate for (acme and acmedomain0..5 in the node's config).
      method: "PUT",
      re: /^\/api\/node\/acme\/config$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "account", "domains", "digest"]);
        const account = body.account === null || body.account === undefined || body.account === "" ? null : configId(body.account, "account name");
        const list = body.domains === undefined ? [] : body.domains;
        if (!Array.isArray(list) || list.length > 6) bad("A node can order a certificate for up to 6 domains");
        const domainRe = /^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
        const params: Record<string, string | undefined> = {};
        const gone: string[] = [];
        list.forEach((x, i) => {
          if (!x || typeof x !== "object") bad("Each domain needs a name");
          const e = x as Record<string, unknown>;
          noExtra(e, ["domain", "plugin", "alias"]);
          if (typeof e.domain !== "string" || !domainRe.test(e.domain)) bad("A domain looks like pve.example.com");
          const plugin = e.plugin ? configId(e.plugin, "plugin name") : undefined;
          if (e.alias && (typeof e.alias !== "string" || !domainRe.test(e.alias))) bad("An alias is a domain name");
          params[`acmedomain${i}`] = `domain=${e.domain}${plugin ? `,plugin=${plugin}` : ""}${e.alias ? `,alias=${e.alias}` : ""}`;
        });
        for (let i = list.length; i < 6; i++) gone.push(`acmedomain${i}`);
        if (account) params.acme = `account=${account}`;
        else gone.push("acme");
        const digest = body.digest === undefined || body.digest === null ? undefined : str(body.digest, 40) ?? bad("Bad digest");
        await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          await pve.call("PUT", `/nodes/${seg(node)}/config`, { ...params, delete: gone.join(","), digest });
        });
        c.json(200, { ok: true });
      },
    },
    ...(["order", "renew"] as const).map(
      (kind): Route => ({
        method: "POST",
        re: new RegExp(`^/api/node/acme/${kind}$`),
        run: async (c) => {
          c.sameSite();
          const body = await c.readJson();
          noExtra(body, ["node", "force"]);
          const force = body.force === true ? true : undefined;
          const task = await c.asUser(async (pve) => {
            const node = await resolveNode(c, pve, body);
            const cfg = acmeConfig(await pve.call<Record<string, unknown>>("GET", `/nodes/${seg(node)}/config`).catch((e) => {
              if (e instanceof ProxmoxError && e.status === 403) return {};
              throw e;
            }));
            if (cfg.domains.length === 0 && kind === "order") throw new HttpError(400, "no_domains", "Set an ACME account and at least one domain for this node first");
            const upid = await pve.call<string>(kind === "order" ? "POST" : "PUT", `/nodes/${seg(node)}/certificates/acme/certificate`, { force });
            if (node === c.node) afterTask(pve, node, upid);
            return upid;
          });
          c.json(202, { task });
        },
      }),
    ),
    {
      method: "DELETE",
      re: /^\/api\/node\/acme\/certificate$/,
      run: async (c) => {
        c.sameSite();
        const body = await c.readJson();
        noExtra(body, ["node", "confirm"]);
        confirmed(body, "remove certificate", "going back to the node's own certificate");
        const task = await c.asUser(async (pve) => {
          const node = await resolveNode(c, pve, body);
          const upid = await pve.call<string>("DELETE", `/nodes/${seg(node)}/certificates/acme/certificate`);
          if (node === c.node) afterTask(pve, node, upid);
          return upid;
        });
        c.json(202, { task });
      },
    },
  ];
}

