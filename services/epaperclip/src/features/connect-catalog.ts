import { isIP } from "node:net";
import { HttpError } from "../http.ts";
import { isPrivateAddress } from "../vendorFetch.ts";

/**
 * The provider catalog behind Connectors: which model services ePaperclip knows how to talk to, and the rules for the
 * addresses an administrator may point it at. Hosted providers have a fixed address; local and custom ones (Ollama,
 * LM Studio, any OpenAI-compatible server) take an address, checked here. Nothing in this file is secret.
 */

export type CatalogKind = "hosted" | "local" | "custom";

export interface CatalogEntry {
  id: string;
  label: string;
  kind: CatalogKind;
  protocol: "anthropic" | "openai" | "gemini";
  /** The default (hosted: only) address, without a trailing slash. */
  base: string;
  /** Local and custom entries let the administrator type the address. */
  baseEditable: boolean;
  keyRequired: boolean;
  /** Where a person gets a key (https, shown as a link). */
  keysUrl?: string;
  /** For services without a model list: test with a one-token chat on this model instead. */
  testModel?: string;
  /** The provider's name in the engine's AI connections, when agents can use it through the engine. */
  engine?: "anthropic" | "openai" | "openrouter" | "xai";
  /** Whether this provider can be signed in with a subscription from an agent container (device login), docs/CONNECTORS.md. */
  subscription?: boolean;
  /** Built in to Connectors (keys are managed by the connectors store). */
  builtin?: boolean;
  note?: string;
}

const hosted = (id: string, label: string, base: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ id, label, kind: "hosted", protocol: "openai", base, baseEditable: false, keyRequired: true, ...extra });
const local = (id: string, label: string, base: string, note: string): CatalogEntry => ({ id, label, kind: "local", protocol: "openai", base, baseEditable: true, keyRequired: false, note });

export const CATALOG: readonly CatalogEntry[] = [
  { id: "anthropic", label: "Anthropic", kind: "hosted", protocol: "anthropic", base: "https://api.anthropic.com/v1", baseEditable: false, keyRequired: true, keysUrl: "https://console.anthropic.com/settings/keys", engine: "anthropic", subscription: true, builtin: true },
  { id: "openai", label: "OpenAI", kind: "hosted", protocol: "openai", base: "https://api.openai.com/v1", baseEditable: false, keyRequired: true, keysUrl: "https://platform.openai.com/api-keys", engine: "openai", subscription: true, builtin: true },
  { id: "gemini", label: "Google Gemini", kind: "hosted", protocol: "gemini", base: "https://generativelanguage.googleapis.com/v1beta", baseEditable: false, keyRequired: true, keysUrl: "https://aistudio.google.com/apikey", builtin: true, note: "Answers in words only for now; no tools." },
  { id: "openrouter", label: "OpenRouter", kind: "hosted", protocol: "openai", base: "https://openrouter.ai/api/v1", baseEditable: false, keyRequired: true, keysUrl: "https://openrouter.ai/keys", engine: "openrouter", builtin: true },
  hosted("xai", "xAI", "https://api.x.ai/v1", { keysUrl: "https://console.x.ai", engine: "xai" }),
  hosted("mistral", "Mistral", "https://api.mistral.ai/v1", { keysUrl: "https://console.mistral.ai/api-keys" }),
  hosted("groq", "Groq", "https://api.groq.com/openai/v1", { keysUrl: "https://console.groq.com/keys" }),
  hosted("deepseek", "DeepSeek", "https://api.deepseek.com/v1", { keysUrl: "https://platform.deepseek.com/api_keys" }),
  hosted("together", "Together AI", "https://api.together.xyz/v1", { keysUrl: "https://api.together.ai/settings/api-keys" }),
  hosted("fireworks", "Fireworks AI", "https://api.fireworks.ai/inference/v1", { keysUrl: "https://fireworks.ai/account/api-keys" }),
  hosted("perplexity", "Perplexity", "https://api.perplexity.ai", { keysUrl: "https://www.perplexity.ai/settings/api", testModel: "sonar", note: "Has no model list; tested with a one-token question." }),
  hosted("cerebras", "Cerebras", "https://api.cerebras.ai/v1", { keysUrl: "https://cloud.cerebras.ai" }),
  hosted("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1", { keysUrl: "https://build.nvidia.com" }),
  hosted("deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai", { keysUrl: "https://deepinfra.com/dash/api_keys" }),
  hosted("huggingface", "Hugging Face", "https://router.huggingface.co/v1", { keysUrl: "https://huggingface.co/settings/tokens" }),
  hosted("sambanova", "SambaNova", "https://api.sambanova.ai/v1", { keysUrl: "https://cloud.sambanova.ai/apis" }),
  hosted("moonshot", "Moonshot (Kimi)", "https://api.moonshot.ai/v1", { keysUrl: "https://platform.moonshot.ai" }),
  hosted("zai", "Z.ai (GLM)", "https://api.z.ai/api/paas/v4"),
  local("ollama", "Ollama", "http://localhost:11434/v1", "Run models on a machine you own. \"localhost\" here means this Proxmox host; use the address of the machine or container that runs Ollama."),
  local("lmstudio", "LM Studio", "http://localhost:1234/v1", "Start LM Studio's local server and use that computer's address."),
  local("llamacpp", "llama.cpp server", "http://localhost:8080/v1", "The address of `llama-server`."),
  local("vllm", "vLLM", "http://localhost:8000/v1", "The address of a vLLM OpenAI-compatible server."),
  local("jan", "Jan", "http://localhost:1337/v1", "Jan's local API server."),
  { id: "openai-compatible", label: "Other OpenAI-compatible", kind: "custom", protocol: "openai", base: "", baseEditable: true, keyRequired: false, note: "Any server that speaks the OpenAI chat API: LocalAI, text-generation-webui, LiteLLM, a company gateway." },
];

export const catalogEntry = (id: string): CatalogEntry | undefined => CATALOG.find((c) => c.id === id);

const LAN_SUFFIX = /\.(local|localhost|localdomain|internal|lan|home|corp|intranet|home\.arpa)$/;

/**
 * Checks an address typed by an administrator for a local or custom endpoint. Http is only for machines on this
 * network (loopback, private addresses, `.local`/`.lan` names, single-word names); anything on the public internet
 * must be https. Cloud metadata addresses are never allowed. No user name, query or fragment. Returns the address
 * without a trailing slash.
 */
export function checkBaseUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300 || /[\u0000- \u007f]/.test(raw.trim())) throw new HttpError(400, "bad_address", "Enter the server's address, like http://192.168.1.20:11434/v1");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "bad_address", "That isn't a web address. Try http://192.168.1.20:11434/v1");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "bad_address", "The address must start with http:// or https://");
  if (u.username || u.password) throw new HttpError(400, "bad_address", "Put the key in the key field, not in the address.");
  if (u.search || u.hash) throw new HttpError(400, "bad_address", "The address can't have a query or fragment.");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host) === 4 && /^169\.254\./.test(host)) throw new HttpError(400, "bad_address", "That address isn't allowed.");
  if (isIP(host) === 6 && /^fe[89ab]|^fd00:ec2/.test(host)) throw new HttpError(400, "bad_address", "That address isn't allowed.");
  if (host === "metadata.google.internal" || host === "0.0.0.0" || host === "::") throw new HttpError(400, "bad_address", "That address isn't allowed.");
  if (u.protocol === "http:") {
    const lan = host === "localhost" || (isIP(host) !== 0 && isPrivateAddress(host)) || (isIP(host) === 0 && (!host.includes(".") || LAN_SUFFIX.test(host)));
    if (!lan) throw new HttpError(400, "bad_address", "Plain http is only for servers on your own network. Use https for anything on the internet.");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
