import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { KeyRound, Sparkles } from "lucide-react";
import { errorMessage } from "../../../data/engine/pinRuntimeApi.ts";
import { notesApi, type NoteFull, type SecretWarning } from "../../../data/engine/notesApi.ts";
import { Button, Notice, Textarea } from "../../../ui/primitives.tsx";
import { NOTES_KEY, useDevice } from "./common.tsx";

/**
 * Quick capture: type or paste, press Save, it goes to the Inbox as written. "Sort with Pin" instead cuts a longer
 * paste into notes and opens the review screen. A likely secret is flagged right away, with the way out.
 */
export function SecretBanner({ note, warnings, onChanged }: { note: Pick<NoteFull, "id">; warnings: SecretWarning[]; onChanged: () => void }) {
  const qc = useQueryClient();
  const fix = useMutation({
    mutationFn: (action: "redact" | "vault") => notesApi.secrets(note.id, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      onChanged();
    },
  });
  if (!warnings.length) return null;
  return (
    <Notice
      tone="warning"
      title={`This note looks like it holds ${warnings.length === 1 ? "a secret" : `${warnings.length} secrets`}`}
      action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={fix.isPending} onClick={() => fix.mutate("vault")}><KeyRound className="h-3.5 w-3.5" />Move to vault</Button>
          <Button size="sm" variant="ghost" loading={fix.isPending} onClick={() => fix.mutate("redact")}>Redact</Button>
        </div>
      }
    >
      {warnings.map((w) => `${w.label} (line ${w.line})`).join(", ")}. Notes are encrypted on the device, but passwords and keys are safer in the vault. Pin never sends them to a model.
      {fix.error ? <span className="block text-critical mt-1">{errorMessage(fix.error)}</span> : null}
    </Notice>
  );
}

export function QuickNote({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState<{ note: NoteFull; warnings: SecretWarning[] } | null>(null);
  const qc = useQueryClient();
  const nav = useNavigate();
  const device = useDevice();
  const save = useMutation({
    mutationFn: () => notesApi.capture(text),
    onSuccess: (r) => {
      setSaved(r);
      setText("");
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      if (!r.warnings.length) onDone?.();
    },
  });
  const sort = useMutation({
    mutationFn: () => notesApi.sort({ text }),
    onSuccess: (r) => {
      if (r.draft) nav(`/${device}/notes?draft=${r.draft.id}`);
      else nav(`/${device}/notes`);
      qc.invalidateQueries({ queryKey: NOTES_KEY });
      onDone?.();
    },
  });
  const err = save.error ?? sort.error;
  return (
    <div className="space-y-3">
      <Textarea value={text} onChange={(e) => { setText(e.target.value); setSaved(null); }} rows={compact ? 5 : 4} aria-label="Quick note" placeholder="Jot something down, or paste a pile of text: runbooks, IPs, logs, to-dos..." className="min-h-24" />
      {err && <p role="alert" className="text-compact text-critical">{errorMessage(err)}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!text.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save to Inbox</Button>
        <Button disabled={!text.trim()} loading={sort.isPending} onClick={() => sort.mutate()}><Sparkles className="h-4 w-4" />Sort with Pin</Button>
        <span className="text-xs text-ink-3">Sorting shows you a preview first.</span>
      </div>
      {saved && (saved.warnings.length > 0 ? <SecretBanner note={saved.note} warnings={saved.warnings} onChanged={() => { setSaved(null); onDone?.(); }} /> : <p className="text-compact text-good" role="status">Saved to the Inbox.</p>)}
    </div>
  );
}
