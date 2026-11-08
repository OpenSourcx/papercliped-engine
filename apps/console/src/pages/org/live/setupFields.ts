import type { FieldDef } from "@papercliped-engine/engine-client";

export type FieldValues = Record<string, string | boolean>;

/** Fields the person sees. Hidden ones are never shown but their defaults are still sent. */
export const shownFields = (fields: FieldDef[]) => fields.filter((field) => !field.hidden);

/** Defaults for every field, hidden ones included, so a submitted form carries what the provider definition asks for. */
export function defaultValues(fields: FieldDef[]): FieldValues {
  const out: FieldValues = {};
  for (const field of fields) {
    if (field.type === "checkbox") out[field.key] = field.defaultValue === true || field.defaultValue === "true";
    else if (field.defaultValue !== undefined) out[field.key] = String(field.defaultValue);
  }
  return out;
}

const text = (value: string | boolean | undefined) => (typeof value === "string" ? value.trim() : "");

/** A short message when the value is not acceptable, or null. Required, max length, pattern, and ISO date-time. */
export function fieldError(field: FieldDef, value: string | boolean | undefined): string | null {
  if (field.hidden || field.type === "checkbox") return null;
  const v = text(value);
  if (!v) return field.required ? `${field.label} is required.` : null;
  if (field.validation?.maxLength && v.length > field.validation.maxLength) return `${field.label} can be at most ${field.validation.maxLength} characters.`;
  if (field.type === "datetime" && Number.isNaN(Date.parse(v))) return `${field.label} must be a date and time such as 2026-11-07T15:30.`;
  if (field.validation?.pattern) {
    try { if (!new RegExp(field.validation.pattern).test(v)) return `${field.label} is not in the expected format.`; } catch { /* a pattern the browser cannot compile is the provider definition's problem; the engine validates again */ }
  }
  return null;
}

export const firstFieldError = (fields: FieldDef[], values: FieldValues): string | null => {
  for (const field of fields) { const e = fieldError(field, values[field.key]); if (e) return e; }
  return null;
};

/** Settings go as typed values (checkbox true/false, date-time as ISO); empty optional fields are left out. */
export function configPayload(fields: FieldDef[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const v = values[field.key];
    if (field.type === "checkbox") out[field.key] = v === true;
    else if (text(v)) out[field.key] = field.type === "datetime" ? new Date(text(v)).toISOString() : text(v);
  }
  return out;
}

/** Credentials are strings only; a prefix the provider requires is added once, and empty optional fields are left out. */
export function credentialPayload(fields: FieldDef[], values: FieldValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const v = values[field.key];
    if (field.type === "checkbox") { out[field.key] = v === true ? "true" : "false"; continue; }
    const t = text(v);
    if (t) out[field.key] = field.prefix && !t.startsWith(field.prefix) ? `${field.prefix}${t}` : t;
  }
  return out;
}
