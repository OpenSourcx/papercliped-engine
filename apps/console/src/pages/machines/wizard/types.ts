import type { WizardOptions } from "../../../data/engine/wizard.ts";

/** What every step gets: the form, a way to change it, what the node offers, and the check's message for a field. */
export interface StepProps<F> {
  f: F;
  set: (patch: Partial<F>) => void;
  o: WizardOptions;
  /** The shared check's message when it is about this field (or something inside it), else null. */
  err: (field: string) => string | null;
}
