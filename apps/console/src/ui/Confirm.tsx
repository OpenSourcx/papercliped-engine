import { useState, type ReactNode } from "react";
import { Modal } from "./Modal.tsx";
import { Button } from "./primitives.tsx";

export interface ConfirmRequest {
  title: string;
  body?: ReactNode;
  /** The action button's label, such as "Shut down". */
  label: string;
  /** Red button for anything that cuts power, loses data or changes what the system is doing for other people. */
  danger?: boolean;
  run: () => void | Promise<unknown>;
}

/** One extra step before an action that is hard to undo: nothing dangerous happens on the first click. */
export function ConfirmModal({ title, body, label, danger, busy, onConfirm, onClose }: { title: string; body?: ReactNode; label: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal size="sm" title={title} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={danger ? "danger" : "primary"} loading={busy} onClick={onConfirm}>{label}</Button></>}>
      {body ? <div className="text-compact text-ink-2 text-pretty">{body}</div> : null}
    </Modal>
  );
}

/** `const { ask, dialog } = useConfirm()`; call `ask({ title, label, run })` from a click and render `{dialog}` once. */
export function useConfirm() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => { setReq(null); setBusy(false); };
  const dialog = req ? (
    <ConfirmModal title={req.title} body={req.body} label={req.label} danger={req.danger} busy={busy} onClose={close} onConfirm={() => {
      setBusy(true);
      Promise.resolve(req.run()).finally(close);
    }} />
  ) : null;
  return { ask: setReq, dialog };
}
