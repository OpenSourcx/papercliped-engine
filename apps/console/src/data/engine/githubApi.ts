import { NodeApiError } from "./nodeApi.ts";

/** Pull-request tracking (services/epaperclip/src/features/github.ts). The token is write-only: only its last four characters return. */

async function req<T>(method: "GET" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: method === "GET" ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json", "X-EPC-Request": "1" },
      body: method === "PUT" ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new NodeApiError(0, "Can't reach this device", "offline");
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string };
    throw new NodeApiError(res.status, d.error ?? `Request failed (${res.status})`, d.code ?? null);
  }
  return data as T;
}

export interface GithubStatus { connected: boolean; login: string | null; last4: string | null; repos: string[]; canManage: boolean }
export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  branch: string;
  updatedAt: string;
  url: string;
  checks: "success" | "failure" | "pending" | null;
}
export interface PullRequests { connected: boolean; prs: PullRequest[]; errors: { repo: string; message: string }[] }

export const githubApi = {
  status: () => req<GithubStatus>("GET", "/api/github"),
  connect: (b: { token?: string; repos?: string[] }) => req<GithubStatus>("PUT", "/api/github", b),
  disconnect: () => req<GithubStatus>("DELETE", "/api/github"),
  prs: () => req<PullRequests>("GET", "/api/github/prs"),
};
