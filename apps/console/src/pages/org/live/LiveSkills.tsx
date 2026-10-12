import { useState } from "react";
import { Boxes, Download, FileText, RefreshCw, Search } from "lucide-react";
import type { CompanySkillListItem } from "@papercliped-engine/engine-client";
import { useAgents } from "../../../data/engine/queries.ts";
import { useSkill, useSkillCatalog, useSkillFile, useSkills, useSkillSources, useSkillWrites } from "../../../data/engine/more.ts";
import { Modal } from "../../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, PageFrame, PageHeader, Tabs, Toggle } from "../../../ui/primitives.tsx";
import { ActionError, LoadError, Loading, useLiveOrg } from "./common.tsx";

type Tab = "installed" | "catalog" | "sources";
type CatalogEntry = { id: string; key: string; name: string; description?: string; category?: string; kind?: string; trustLevel?: string; recommendedForRoles?: string[] };
type SourceRow = { id: string; label?: string; name?: string; kind?: string; locator?: string; url?: string; repository?: string; status?: string; updatedAt?: string; lastRefreshedAt?: string; skillCount?: number };

/** The text of a skill file. Shown as plain text: skill files are written by other people and never rendered as markup. */
function FileText_({ text }: { text: string }) {
  return <pre className="font-mono text-compact text-ink-2 bg-code rounded-lg p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words">{text}</pre>;
}

function SkillModal({ skillId, onClose }: { skillId: string; onClose: () => void }) {
  const { companyId } = useLiveOrg();
  const skill = useSkill(companyId, skillId);
  const [path, setPath] = useState("SKILL.md");
  const file = useSkillFile(companyId, skillId, path);
  const w = useSkillWrites(companyId);
  const s = skill.data;
  return (
    <Modal title={s?.name ?? "Skill"} subtitle={s?.description ?? undefined} size="lg" onClose={onClose}>
      {skill.isPending && <Loading />}
      {skill.error && <LoadError error={skill.error} retry={() => void skill.refetch()} />}
      {s && (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2">
            <Chip>{s.sourceLabel ?? s.sourceBadge}</Chip>
            <Chip>{s.trustLevel === "markdown_only" ? "Text only" : s.trustLevel === "assets" ? "Has assets" : "Runs scripts"}</Chip>
            {!s.editable && <Chip>Read only</Chip>}
          </div>
          <div>
            <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-2">Agents</h3>
            {s.usedByAgents.length === 0 && <p className="text-sm text-ink-3">No agent uses this skill yet. Turn it on for an agent below.</p>}
            <AgentSwitches skillKey={s.key} />
            <ActionError error={w.syncAgent.error} />
          </div>
          <div>
            <h3 className="text-compact font-semibold uppercase tracking-label text-ink-3 mb-2">Files</h3>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {s.fileInventory.map((f) => <button key={f.path} onClick={() => setPath(f.path)} className={`inline-flex items-center gap-1 rounded-md px-2 h-7 text-compact font-mono ${f.path === path ? "bg-surface-3 text-ink" : "text-ink-3 hover:bg-surface-2"}`}><FileText className="h-3 w-3" aria-hidden />{f.path}</button>)}
            </div>
            {file.isPending && <Loading />}
            {file.error && <LoadError error={file.error} retry={() => void file.refetch()} />}
            {file.data && (file.data.encoding === "base64" ? <p className="text-sm text-ink-3">This file isn't text, so it isn't shown.</p> : <FileText_ text={file.data.content} />)}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One switch per agent for a skill. Agents whose adapter can't take skills are shown but off. */
function AgentSwitches({ skillKey }: { skillKey: string }) {
  const { companyId } = useLiveOrg();
  const agents = useAgents(companyId);
  const skills = useSkills(companyId);
  const w = useSkillWrites(companyId);
  const skill = (skills.data ?? []).find((x) => x.key === skillKey);
  const detail = useSkill(companyId, skill?.id ?? null);
  const on = new Set((detail.data?.usedByAgents ?? []).filter((a) => a.desired).map((a) => a.id));
  const list = (agents.data ?? []).filter((a) => a.status !== "terminated");
  if (list.length === 0) return <p className="text-sm text-ink-3">Create an agent first.</p>;
  return (
    <div className="divide-y divide-line rounded-lg border border-line">
      {list.map((a) => (
        <div key={a.id} className="flex items-center gap-3 px-3 py-2">
          <span className="flex-1 text-sm">{a.name}<span className="text-xs text-ink-3 ml-2">{a.adapterType}</span></span>
          <Toggle label={`${on.has(a.id) ? "Remove" : "Add"} ${skillKey.split("/").pop()} for ${a.name}`} checked={on.has(a.id)} disabled={w.syncAgent.isPending} onChange={(v) => w.syncAgent.mutate({ agentId: a.id, mode: v ? "add" : "remove", desired: [skillKey] })} />
        </div>
      ))}
    </div>
  );
}

export function LiveSkills() {
  const { companyId, org } = useLiveOrg();
  const skills = useSkills(companyId);
  const [tab, setTab] = useState<Tab>("installed");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const catalog = useSkillCatalog(tab === "catalog");
  const sources = useSkillSources(companyId);
  const w = useSkillWrites(companyId);
  const needle = q.trim().toLowerCase();
  const match = (...t: (string | undefined | null)[]) => !needle || t.some((x) => x?.toLowerCase().includes(needle));
  const installed = (skills.data ?? []).filter((s: CompanySkillListItem) => match(s.name, s.description, s.key));
  const installedKeys = new Set((skills.data ?? []).map((s) => s.key));
  const cat = ((catalog.data ?? []) as unknown as CatalogEntry[]).filter((c) => match(c.name, c.description, c.category));
  const src = (sources.data ?? []) as unknown as SourceRow[];
  return (
    <PageFrame width="4xl">
      <PageHeader title="Skills" subtitle={`Reusable know-how ${org.name}'s agents can use. Turn a skill on for the agents that should have it.`} />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: "installed", label: "Installed", count: skills.data?.length }, { id: "catalog", label: "Catalog" }, { id: "sources", label: "Sources" }]} />
        {tab !== "sources" && (
          <div className="relative flex-1 min-w-48 max-w-sm ml-auto">
            <Search className="h-4 w-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
            <Input aria-label="Search skills" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search skills" className="h-9 pl-9" />
          </div>
        )}
      </div>

      {tab === "installed" && (
        <Card className="divide-y divide-line">
          {skills.isPending && <Loading label="Loading skills" />}
          {skills.error && <LoadError error={skills.error} retry={() => void skills.refetch()} />}
          {skills.data && installed.length === 0 && <EmptyState icon={<Boxes className="h-5 w-5" />} title={skills.data.length ? "No match" : "No skills yet"} body={skills.data.length ? "No installed skill matches that search." : "Install one from the catalog."} />}
          {installed.map((s) => (
            <button key={s.id} onClick={() => setOpen(s.id)} className="w-full text-left flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-surface-2/40">
              <Boxes className="h-4 w-4 text-ink-3 shrink-0" aria-hidden />
              <div className="flex-1 min-w-48"><div className="text-sm font-medium">{s.name}</div><div className="text-xs text-ink-3 line-clamp-1">{s.description}</div></div>
              <Chip>{s.sourceLabel ?? s.sourceBadge}</Chip>
              <span className="text-xs text-ink-3 w-24 text-right">{s.attachedAgentCount === 1 ? "1 agent" : `${s.attachedAgentCount} agents`}</span>
            </button>
          ))}
        </Card>
      )}

      {tab === "catalog" && (
        <Card className="divide-y divide-line">
          {catalog.isPending && <Loading label="Loading the catalog" />}
          {catalog.error && <LoadError error={catalog.error} retry={() => void catalog.refetch()} />}
          {catalog.data && cat.length === 0 && <EmptyState icon={<Boxes className="h-5 w-5" />} title="No match" body="Nothing in the catalog matches that search." />}
          {cat.map((c) => {
            const have = installedKeys.has(c.key);
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-48"><div className="text-sm font-medium">{c.name}</div><div className="text-xs text-ink-3 line-clamp-2">{c.description}</div></div>
                {c.category && <Chip>{c.category}</Chip>}
                {have ? <Chip tone="good">Installed</Chip> : <Button size="sm" loading={w.installCatalog.isPending && w.installCatalog.variables === c.id} onClick={() => w.installCatalog.mutate(c.id)}><Download className="h-3.5 w-3.5" />Install</Button>}
              </div>
            );
          })}
        </Card>
      )}
      {tab === "catalog" && <ActionError error={w.installCatalog.error} />}

      {tab === "sources" && (
        <>
          <Notice tone="info" className="mb-3">Sources are where installed skills come from, such as a Git repository. Adding a source is done in the engine; here you can see them and refresh.</Notice>
          <Card className="divide-y divide-line">
            {sources.isPending && <Loading />}
            {sources.error && <LoadError error={sources.error} retry={() => void sources.refetch()} />}
            {sources.data && src.length === 0 && <EmptyState icon={<Boxes className="h-5 w-5" />} title="No sources" body="Bundled and catalog skills don't need one." />}
            {src.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-48"><div className="text-sm font-medium">{r.label ?? r.name ?? r.repository ?? r.locator ?? r.url ?? r.id}</div><div className="text-xs text-ink-3 font-mono truncate">{r.url ?? r.locator ?? r.repository ?? ""}</div></div>
                {r.skillCount !== undefined && <span className="text-xs text-ink-3">{r.skillCount} skills</span>}
                <Button size="sm" variant="ghost" loading={w.refreshSource.isPending && w.refreshSource.variables === r.id} onClick={() => w.refreshSource.mutate(r.id)}><RefreshCw className="h-3.5 w-3.5" />Refresh</Button>
              </div>
            ))}
          </Card>
          <ActionError error={w.refreshSource.error} />
        </>
      )}
      {open && <SkillModal skillId={open} onClose={() => setOpen(null)} />}
    </PageFrame>
  );
}
