import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Users } from "lucide-react";
import { access, type Group } from "../../data/engine/access.ts";
import { errorText } from "../../data/engine/queries.ts";
import { Modal } from "../../ui/Modal.tsx";
import { Button, Card, Chip, EmptyState, Input, Notice, SectionTitle } from "../../ui/primitives.tsx";
import { IAC_KEY, QueryState, ReadOnlyNote, Table, Td, Th, Warnings, plural, useIac, AField as Field } from "./shared.tsx";

const KEY = ["access", "groups"] as const;

/** Who is in a group: a checklist of Proxmox users. */
export function MemberPicker({ users, value, onChange }: { users: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="max-h-48 overflow-y-auto rounded-lg border border-line divide-y divide-line" role="group" aria-label="Members">
      {users.map((u) => (
        <label key={u} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-surface-2/60">
          <input type="checkbox" className="h-4 w-4 accent-(--accent)" checked={value.includes(u)} onChange={(e) => onChange(e.target.checked ? [...value, u] : value.filter((x) => x !== u))} />
          <span className="font-mono text-compact">{u}</span>
        </label>
      ))}
      {users.length === 0 && <p className="px-3 py-2 text-compact text-ink-3">Proxmox lists no users for your account.</p>}
    </div>
  );
}

function Effective({ groupid }: { groupid: string }) {
  const q = useQuery({ queryKey: [...KEY, groupid, "permissions"], queryFn: () => access.groups.permissions(groupid), retry: 0 });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isPending) return <p className="text-compact text-ink-3">Reading permissions…</p>;
  if (q.error) return <p className="text-compact text-ink-3">{errorText(q.error)}</p>;
  if (!q.data.entries.length) return <p className="text-compact text-ink-3">This group has no permissions yet. Give it a role on a path in Roles &amp; permissions.</p>;
  return (
    <ul className="rounded-lg border border-line divide-y divide-line">
      {q.data.entries.map((e) => {
        const id = `${e.path} ${e.roleid}`;
        return (
          <li key={id} className="px-3 py-2">
            <button type="button" className="w-full text-left flex flex-wrap items-center gap-2" onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
              <span className="font-mono text-compact">{e.path}</span>
              <Chip tone="accent">{e.roleid}</Chip>
              <span className="text-xs text-ink-3">{plural(e.privileges.length, "privilege")}{e.propagate ? " · applies below this path" : " · this path only"}</span>
            </button>
            {open === id && <p className="mt-2 text-xs text-ink-2 font-mono break-words">{e.privileges.join(", ") || "None"}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function GroupModal({ group, users, onClose, onDone }: { group: Group | null; users: string[]; onClose: () => void; onDone: (w: string[]) => void }) {
  const qc = useQueryClient();
  const creating = !group;
  const [groupid, setGroupid] = useState("");
  const [comment, setComment] = useState(group?.comment ?? "");
  const [members, setMembers] = useState<string[]>(group?.members ?? []);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = (warnings: string[]) => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: IAC_KEY });
    onDone(warnings);
    onClose();
  };
  const save = useMutation({
    mutationFn: () => (creating ? access.groups.create({ groupid: groupid.trim(), comment: comment.trim() || undefined, members }) : access.groups.update(group.groupid, { comment: comment.trim(), members })),
    onSuccess: (r) => done(r.warnings),
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({ mutationFn: () => access.groups.remove(group!.groupid), onSuccess: () => done([]), onError: (e) => setError(errorText(e)) });
  const valid = !creating || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(groupid.trim());
  return (
    <Modal
      size="lg"
      icon={<Users className="h-5 w-5" />}
      title={creating ? "New group" : group.groupid}
      subtitle="Groups give several people the same permissions at once."
      onClose={onClose}
      footer={
        <>
          {!creating && !confirm && <Button variant="ghost" className="mr-auto text-critical" onClick={() => setConfirm(true)}><Trash2 className="h-4 w-4" />Delete group</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>{creating ? "Create group" : "Save group"}</Button>
        </>
      }
    >
      <div className="space-y-5">
        {creating && <Field label="Group name" hint="Letters, digits, . _ and -"><Input value={groupid} onChange={(e) => setGroupid(e.target.value)} className="font-mono" autoFocus spellCheck={false} /></Field>}
        <Field label="Comment"><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <Field label="Members" hint={`${plural(members.length, "member")} selected. A person can be in several groups.`}>
          <MemberPicker users={users} value={members} onChange={setMembers} />
        </Field>
        {!creating && (
          <div>
            <div className="text-compact font-medium text-ink-2 mb-1.5">What this group can do</div>
            <Effective groupid={group.groupid} />
          </div>
        )}
        {confirm && group && (
          <Notice tone="critical" title={`Delete ${group.groupid}?`} action={<Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete group</Button>}>
            Its members stay, but they lose what this group gave them, and its permissions are removed.
          </Notice>
        )}
        {error && <p role="alert" className="text-compact text-critical">{error}</p>}
      </div>
    </Modal>
  );
}

export function GroupsTab() {
  const q = useQuery({ queryKey: KEY, queryFn: access.groups.list, retry: 1 });
  const iacQ = useIac();
  const [editing, setEditing] = useState<Group | "new" | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const users = (iacQ.data?.users ?? []).map((u) => u.userid);
  return (
    <QueryState query={q}>
      {q.data && (
        <>
          <SectionTitle action={q.data.canManage ? <Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />New group</Button> : undefined}>Groups</SectionTitle>
          {!q.data.canManage && <ReadOnlyNote what="manage groups" />}
          <Warnings items={notes} />
          {q.data.groups.length === 0 ? (
            <EmptyState icon={<Users className="h-5 w-5" />} title="No groups yet" body="Create a group, add people to it, then give the group a role on a path. Everyone in it gets the same access." />
          ) : (
            <Table>
              <thead><tr className="border-b border-line"><Th>Group</Th><Th>Members</Th><Th>Comment</Th></tr></thead>
              <tbody>
                {q.data.groups.map((g) => (
                  <tr key={g.groupid} className="border-b border-line last:border-0 hover:bg-surface-2/50">
                    <Td><button className="font-medium text-left hover:underline" onClick={() => setEditing(g)}>{g.groupid}</button></Td>
                    <Td><div className="flex flex-wrap gap-1.5">{g.members.length ? g.members.map((m) => <Chip key={m}>{m}</Chip>) : <span className="text-compact text-ink-3">Nobody yet</span>}</div></Td>
                    <Td className="text-ink-2">{g.comment ?? ""}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <Card className="p-4 mt-4 text-compact text-ink-3">Groups are Proxmox groups. People can also be put in groups from their own settings (Users tab).</Card>
        </>
      )}
      {editing && <GroupModal group={editing === "new" ? null : editing} users={users} onClose={() => setEditing(null)} onDone={setNotes} />}
    </QueryState>
  );
}
