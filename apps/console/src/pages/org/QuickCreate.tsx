import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useEngine } from "../../data/store.tsx";
import { Button, Input } from "../../ui/primitives.tsx";
import { Modal } from "../../ui/Modal.tsx";

export type QuickKind = "new-project" | "new-goal" | "new-routine";

const COPY: Record<QuickKind, { title: string; field: string; placeholder: string; cta: string; page: string }> = {
  "new-project": { title: "New project", field: "Name", placeholder: "e.g. Customer portal", cta: "Create project", page: "projects" },
  "new-goal": { title: "New goal", field: "Goal", placeholder: "e.g. Ship the beta to 50 users", cta: "Set goal", page: "goals" },
  "new-routine": { title: "New routine", field: "Name", placeholder: "e.g. Nightly dependency check", cta: "Add routine", page: "routines" },
};

const SCHEDULES = ["Every hour", "Every day at 09:00", "Every weekday at 09:00", "Every Monday at 09:00"];

/** The small "new thing" dialogs Pin's quick actions open inside an organization. */
export function QuickCreateModal({ kind, onClose }: { kind: QuickKind; onClose: () => void }) {
  const engine = useEngine();
  const navigate = useNavigate();
  const device = engine.setup?.deviceName ?? "pve";
  const org = engine.data.orgs.find((o) => o.slug === window.location.pathname.split("/")[2]);
  const c = COPY[kind];
  const [text, setText] = useState("");
  const [agent, setAgent] = useState(org?.agents[0]?.name ?? "");
  const [due, setDue] = useState("");
  const [schedule, setSchedule] = useState(SCHEDULES[1]);

  if (!org) return null;
  const save = () => {
    const t = text.trim();
    if (!t) return;
    if (kind === "new-project") engine.addProject(org.slug, t, agent || null);
    if (kind === "new-goal") engine.addGoal(org.slug, t, due || null);
    if (kind === "new-routine") engine.addRoutine(org.slug, t, schedule, agent);
    onClose();
    navigate(`/${device}/${org.slug}/${c.page}`);
  };

  const select = "h-10 w-full rounded-lg bg-surface-2 border border-line px-3 text-[14px] outline-none focus:border-line-strong";
  return (
    <Modal title={c.title} subtitle={`In ${org.name}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save} disabled={!text.trim() || (kind === "new-routine" && !agent)}>{c.cta}</Button></>}>
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[13px] text-ink-2 mb-2">{c.field}</span>
          <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder={c.placeholder} />
        </label>
        {kind === "new-goal" && (
          <label className="block">
            <span className="block text-[13px] text-ink-2 mb-2">Due <span className="text-ink-3">(optional)</span></span>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        )}
        {kind === "new-routine" && (
          <label className="block">
            <span className="block text-[13px] text-ink-2 mb-2">Runs</span>
            <select value={schedule} onChange={(e) => setSchedule(e.target.value)} className={select}>{SCHEDULES.map((s) => <option key={s}>{s}</option>)}</select>
          </label>
        )}
        {kind !== "new-goal" && (
          <label className="block">
            <span className="block text-[13px] text-ink-2 mb-2">{kind === "new-project" ? "Lead" : "Agent"}</span>
            {org.agents.length ? (
              <select value={agent} onChange={(e) => setAgent(e.target.value)} className={select}>
                {kind === "new-project" && <option value="">No lead yet</option>}
                {org.agents.map((a) => <option key={a.id} value={a.name}>{a.name} · {a.role}</option>)}
              </select>
            ) : (
              <p className="text-[13px] text-ink-3">No agents in {org.name} yet.</p>
            )}
          </label>
        )}
      </div>
    </Modal>
  );
}
