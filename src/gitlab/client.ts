import { URL } from "node:url";

export type GitLabClient = {
  baseUrl: string;
  requestJson<T>(method: "GET" | "POST" | "PUT", path: string, opts?: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }): Promise<{ data: T; headers: Headers }>;
  requestNoBody(method: "POST" | "PUT", path: string, opts?: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }): Promise<{ headers: Headers }>;
};

function buildUrl(baseUrl: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function encodeForm(body: Record<string, unknown> | undefined): string | undefined {
  if (!body) return undefined;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  return params.toString();
}

export function createGitLabClient(input: { baseUrl: string; token: string }): GitLabClient {
  const baseUrl = input.baseUrl.replace(/\/+$/, "") + "/api/v4/";
  const headersBase = {
    "PRIVATE-TOKEN": input.token
  };

  async function requestRaw(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }) {
    const url = buildUrl(baseUrl, path.replace(/^\/+/, ""), opts?.query);
    const form = encodeForm(opts?.body);
    const res = await fetch(url, {
      method,
      headers: {
        ...headersBase,
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {})
      },
      body: form
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`GitLab API ${method} ${path} failed: HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 500)}` : ""}`);
      (err as any).status = res.status;
      throw err;
    }
    return res;
  }

  return {
    baseUrl,
    async requestJson<T>(
      method: "GET" | "POST" | "PUT",
      path: string,
      opts?: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }
    ) {
      const res = await requestRaw(method, path, opts);
      const data = (await res.json()) as T;
      return { data, headers: res.headers };
    },
    async requestNoBody(
      method: "POST" | "PUT",
      path: string,
      opts?: { query?: Record<string, string | number | undefined>; body?: Record<string, unknown> }
    ) {
      const res = await requestRaw(method, path, opts);
      return { headers: res.headers };
    }
  };
}

export async function paginateGitLab<T>(client: GitLabClient, path: string, query: Record<string, string | number | undefined> = {}): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  // GitLab uses keyset or offset pagination depending on endpoint; most list endpoints support page/per_page.
  // We only implement page/per_page here.
  // Docs: https://docs.gitlab.com/api/rest/#pagination
  // (Kept in code comment; no runtime dependency.)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await client.requestJson<T[]>("GET", path, { query: { ...query, per_page: 100, page } });
    all.push(...res.data);
    const next = res.headers.get("x-next-page");
    if (!next) break;
    const n = parseInt(next, 10);
    if (!Number.isFinite(n) || n <= page) break;
    page = n;
  }
  return all;
}
