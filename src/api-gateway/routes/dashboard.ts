import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { safeCompare } from "../auth.js";
import type { WorkerRegistry, WorkerEvent } from "../worker-registry.js";

type DashboardPluginOpts = { registry: WorkerRegistry; apiKey: string };

const COOKIE_NAME = "aw_dashboard";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 12; // 12h

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function isHttps(req: FastifyRequest): boolean {
  const xfProto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "";
  if (xfProto.toLowerCase() === "https") return true;
  const xfSsl = (req.headers["x-forwarded-ssl"] as string | undefined) ?? "";
  if (xfSsl.toLowerCase() === "on") return true;
  return false;
}

function setCookie(reply: FastifyReply, name: string, value: string, opts: { secure: boolean; path: string }): void {
  const enc = encodeURIComponent(value);
  const parts = [
    `${name}=${enc}`,
    `Path=${opts.path}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (opts.secure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

function requireDashboardCookie(expectedApiKey: string) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const cookies = parseCookies(req.headers.cookie as string | undefined);
    const token = cookies[COOKIE_NAME] ?? "";
    if (!safeCompare(token, expectedApiKey)) {
      return reply.code(401).send({ ok: false, error: "unauthorized" }) as unknown as void;
    }
  };
}

function sendFrame(raw: NodeJS.WritableStream, data: unknown): void {
  const json = JSON.stringify(data);
  const seq = (data as WorkerEvent).seq;
  const idLine = typeof seq === "number" ? `id: ${seq}\n` : "";
  raw.write(`${idLine}data: ${json}\n\n`);
}

const CSS = `
:root{
  --bg:#0b0f14;--panel:#0f1620;--panel2:#0c121a;--border:rgba(255,255,255,.08);
  --muted:rgba(255,255,255,.65);--text:rgba(255,255,255,.92);--shadow:rgba(0,0,0,.35);
  --green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#60a5fa;--gray:#94a3b8;
}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
  background: radial-gradient(1200px 800px at 10% 0%, rgba(96,165,250,.08), transparent 50%),
              radial-gradient(900px 700px at 90% 10%, rgba(34,197,94,.06), transparent 55%),
              var(--bg);
  color:var(--text);
}
header{
  position:sticky;top:0;z-index:10;
  backdrop-filter: blur(12px);
  background: rgba(11,15,20,.7);
  border-bottom:1px solid var(--border);
}
.wrap{max-width:1600px;margin:0 auto;padding:14px 18px}
.title-row{display:flex;gap:12px;align-items:center;justify-content:space-between}
.title{font-weight:700;letter-spacing:.2px}
.subtitle{font-size:12px;color:var(--muted);margin-top:2px}
.controls{display:flex;gap:10px;align-items:center}
.btn{
  appearance:none;border:1px solid var(--border);background:rgba(255,255,255,.04);
  color:var(--text);padding:8px 10px;border-radius:10px;font-size:12px;cursor:pointer;
}
.btn:hover{background:rgba(255,255,255,.07)}
.pill{
  border:1px solid var(--border);background:rgba(255,255,255,.03);
  padding:6px 10px;border-radius:999px;font-size:12px;color:var(--muted)
}
.grid{
  display:grid;gap:14px;
}
.project{
  border:1px solid var(--border);border-radius:14px;background:linear-gradient(180deg,var(--panel),var(--panel2));
  box-shadow: 0 12px 30px var(--shadow);
}
.project-h{
  display:flex;justify-content:space-between;gap:12px;align-items:flex-start;
  padding:12px 14px;border-bottom:1px solid var(--border)
}
.project-name{font-weight:700}
.project-meta{font-size:12px;color:var(--muted);display:flex;gap:10px;flex-wrap:wrap}
.term-grid{
  display:grid;gap:12px;padding:12px 14px;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
}
.term{
  border:1px solid var(--border);border-radius:12px;overflow:hidden;background:rgba(0,0,0,.18);
  display:flex;flex-direction:column;min-height:320px
}
.term-h{
  display:flex;align-items:center;gap:10px;padding:10px 10px;border-bottom:1px solid var(--border);
  background:rgba(255,255,255,.03)
}
.dot{width:9px;height:9px;border-radius:99px;background:var(--gray)}
.dot.active{background:var(--green)}
.dot.finished{background:var(--gray)}
.dot.failed{background:var(--red)}
.badge{
  font-size:10px;padding:2px 6px;border-radius:999px;border:1px solid var(--border);color:var(--muted)
}
.badge.active{color:rgba(34,197,94,.95);border-color:rgba(34,197,94,.35);background:rgba(34,197,94,.08)}
.badge.failed{color:rgba(239,68,68,.95);border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08)}
.badge.passive{color:rgba(148,163,184,.95);border-color:rgba(148,163,184,.25);background:rgba(148,163,184,.06)}
.term-title{font-weight:650;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.term-sub{margin-left:auto;font-size:11px;color:var(--muted);display:flex;gap:10px;align-items:center}
.link{color:var(--blue);text-decoration:none}
.link:hover{text-decoration:underline}
.term-body{
  padding:10px;
  background:#000;
  color:#22c55e;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono","Courier New", monospace;
  font-size:12px;
  white-space:pre-wrap;word-break:break-word;
  overflow:auto;flex:1
}
.empty{
  padding:20px;color:var(--muted);text-align:center
}
@media (max-width: 520px){
  .term-grid{grid-template-columns:1fr}
}
`;

const JS = `
const state = {
  workers: [],
  streams: new Map(),
  buffers: new Map(),
  projects: new Map(),
  lastRefresh: null,
};

function $(sel){ return document.querySelector(sel); }
function el(tag, attrs={}, children=[]){
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs||{})){
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, String(v));
  }
  for (const c of children) n.appendChild(c);
  return n;
}

function parseProjectKey(issue){
  if (!issue) return "unknown/unknown";
  const hash = issue.indexOf("#");
  return hash >= 0 ? issue.slice(0, hash) : issue;
}

function fmtTime(ts){
  try{
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit" });
  }catch{ return ts || ""; }
}

function appendLine(correlationId, line){
  const prev = state.buffers.get(correlationId) || "";
  let next = prev + line + "\\n";
  const max = 250_000;
  if (next.length > max) next = next.slice(next.length - max);
  state.buffers.set(correlationId, next);
  const pre = document.querySelector('[data-term-body=\"'+correlationId+'\"]');
  if (pre){
    const shouldStick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = next;
    if (shouldStick) pre.scrollTop = pre.scrollHeight;
  }
}

function formatEvent(ev){
  const ts = ev.ts ? fmtTime(ev.ts) : "";
  if (ev.type === "heartbeat") return null;
  if (ev.type === "stream.closed") return "[stream] closed: " + (ev.reason || "");
  if (ev.type === "lifecycle"){
    const data = ev.data ? JSON.stringify(ev.data) : "";
    return ts ? "["+ts+"] " + ev.event + (data && data !== "{}" ? " " + data : "") : (ev.event || "");
  }
  if (ev.type === "log"){
    const lvl = (ev.level || "info").toUpperCase();
    const fields = ev.fields ? JSON.stringify(ev.fields) : "";
    const msg = ev.event ? ev.event : "";
    const suffix = fields && fields !== "{}" ? " " + fields : "";
    return ts ? "["+ts+"] " + lvl + " " + msg + suffix : (lvl + " " + msg + suffix);
  }
  return JSON.stringify(ev);
}

function sortWorkersForProject(workers){
  const active = workers.filter(w => w.active).sort((a,b) => (b.startedAt||\"\").localeCompare(a.startedAt||\"\"));
  const finished = workers.filter(w => !w.active).sort((a,b) => (b.startedAt||\"\").localeCompare(a.startedAt||\"\"));
  return [...active, ...finished];
}

function render(){
  const root = $("#root");
  root.innerHTML = "";
  const projects = Array.from(state.projects.entries()).sort((a,b) => a[0].localeCompare(b[0]));
  if (projects.length === 0){
    root.appendChild(el("div",{class:"empty",text:"No workers yet. Start autoworker and trigger @worker to see terminals here."}));
    return;
  }

  for (const [projectKey, workers] of projects){
    const sorted = sortWorkersForProject(workers);
    const activeCount = sorted.filter(w => w.active).length;
    const finishedCount = sorted.length - activeCount;

    const project = el("section",{class:"project"});
    const head = el("div",{class:"project-h"},[
      el("div",{},[
        el("div",{class:"project-name",text:projectKey}),
        el("div",{class:"project-meta",html:\`
          <span class="pill">\${activeCount} active</span>
          <span class="pill">\${finishedCount} finished</span>
        \`})
      ])
    ]);
    const grid = el("div",{class:"term-grid"});

    for (const w of sorted){
      const isFailed = !w.active && w.outcome === "failed";
      const dotClass = w.active ? "dot active" : (isFailed ? "dot failed" : "dot finished");
      const badgeClass = w.active ? "badge active" : (isFailed ? "badge failed" : "badge passive");
      const badgeText = w.active ? "ACTIVE" : (isFailed ? "FAILED" : "PASSIVE");

      const term = el("div",{class:"term"});
      const issueLink = w.issueUrl ? \`<a class="link" href="\${w.issueUrl}" target="_blank" rel="noreferrer">\${w.issue}</a>\` : (w.issue || w.correlationId);
      const sub = \`\${w.mode} • \${w.runner} • started \${fmtTime(w.startedAt)}\` + (w.finishedAt ? \` • finished \${fmtTime(w.finishedAt)}\` : \"\");
      const header = el("div",{class:"term-h"},[
        el("span",{class:dotClass}),
        el("span",{class:badgeClass,text:badgeText}),
        el("span",{class:"term-title",html:issueLink}),
        el("span",{class:"term-sub",text:sub}),
      ]);
      const pre = el("pre",{class:"term-body", "data-term-body": w.correlationId, text: state.buffers.get(w.correlationId) || ""});
      term.appendChild(header);
      term.appendChild(pre);
      grid.appendChild(term);
    }

    project.appendChild(head);
    project.appendChild(grid);
    root.appendChild(project);
  }

  $("#lastRefresh").textContent = new Date().toLocaleTimeString();
}

async function fetchWorkers(){
  const res = await fetch("/dashboard/api/workers", { credentials: "same-origin" });
  if (res.status === 401){
    $("#authHint").textContent = "Unauthorized. Open /dashboard/workers with Authorization: Bearer <API_KEY> to set a session cookie.";
    return;
  }
  if (!res.ok){
    $("#authHint").textContent = "Failed to load workers: HTTP " + res.status;
    return;
  }
  const body = await res.json();
  state.workers = body.workers || [];
  state.projects.clear();
  for (const w of state.workers){
    const key = parseProjectKey(w.issue);
    const arr = state.projects.get(key) || [];
    arr.push(w);
    state.projects.set(key, arr);
  }
  render();
  ensureStreams();
}

function ensureStreams(){
  const desired = new Set(state.workers.map(w => w.correlationId));
  for (const [id, es] of state.streams.entries()){
    if (!desired.has(id)){
      try{ es.close(); }catch{}
      state.streams.delete(id);
    }
  }

  for (const w of state.workers){
    if (state.streams.has(w.correlationId)) continue;
    const url = "/dashboard/api/workers/" + encodeURIComponent(w.correlationId) + "/stream";
    const es = new EventSource(url, { withCredentials: true });
    state.streams.set(w.correlationId, es);
    es.onmessage = (msg) => {
      try{
        const ev = JSON.parse(msg.data);
        const line = formatEvent(ev);
        if (line) appendLine(w.correlationId, line);
      }catch(e){
        appendLine(w.correlationId, "[ui] failed to parse event: " + String(e));
      }
    };
    es.onerror = () => appendLine(w.correlationId, "[ui] stream error (will retry)");
  }
}

$("#refreshBtn").addEventListener("click", () => fetchWorkers().catch((e)=>{ $("#authHint").textContent = String(e); }));
fetchWorkers().catch((e)=>{ $("#authHint").textContent = String(e); });
setInterval(() => fetchWorkers().catch(()=>{}), 10_000);
`;

function buildHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>autoworker • Workers</title>
    <link rel="stylesheet" href="/dashboard/workers.css"/>
  </head>
  <body>
    <header>
      <div class="wrap">
        <div class="title-row">
          <div>
            <div class="title">Workers</div>
            <div class="subtitle">Terminal streams per repo/project • active first, then finished</div>
          </div>
          <div class="controls">
            <span class="pill">Last refresh: <span id="lastRefresh">—</span></span>
            <button id="refreshBtn" class="btn">Refresh</button>
          </div>
        </div>
        <div class="subtitle" id="authHint"></div>
      </div>
    </header>
    <main class="wrap">
      <div id="root" class="grid"></div>
    </main>
    <script src="/dashboard/workers.js"></script>
  </body>
</html>`;
}

export const dashboardRoutes: FastifyPluginAsync<DashboardPluginOpts> = async (fastify, opts) => {
  const { registry, apiKey } = opts;

  fastify.get(
    "/dashboard/workers",
    async (
      req: FastifyRequest<{ Querystring: { api_key?: string } }>,
      reply: FastifyReply
    ) => {
      const bearer = ((req.headers.authorization as string | undefined) ?? "").startsWith("Bearer ")
        ? ((req.headers.authorization as string).slice(7) ?? "")
        : "";
      const cookies = parseCookies(req.headers.cookie as string | undefined);
      const cookieToken = cookies[COOKIE_NAME] ?? "";
      const queryToken = req.query.api_key ?? "";

      const ok = safeCompare(bearer, apiKey) || safeCompare(cookieToken, apiKey) || safeCompare(queryToken, apiKey);
      if (!ok) {
        return reply.code(401).send({ ok: false, error: "unauthorized" });
      }

      setCookie(reply, COOKIE_NAME, apiKey, { secure: isHttps(req), path: "/dashboard" });

      // If authenticated via query param, redirect to a clean URL to reduce
      // accidental sharing of the secret in copy/pastes.
      if (queryToken) return reply.redirect(302, "/dashboard/workers");

      return reply.type("text/html; charset=utf-8").send(buildHtml());
    }
  );

  fastify.get("/dashboard", async (_req, reply) => reply.redirect(302, "/dashboard/workers"));

  fastify.get("/dashboard/workers.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(CSS));
  fastify.get("/dashboard/workers.js", async (_req, reply) => reply.type("application/javascript; charset=utf-8").send(JS));

  fastify.get(
    "/dashboard/api/workers",
    { preHandler: requireDashboardCookie(apiKey) },
    async (_req, reply) => reply.send({ workers: registry.list() })
  );

  fastify.get<{ Params: { id: string } }>(
    "/dashboard/api/workers/:id/stream",
    { preHandler: requireDashboardCookie(apiKey) },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const record = registry.get(req.params.id);
      if (!record) {
        return reply.code(404).send({ ok: false, error: "worker_not_found" });
      }
      const workerRecord = record;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });

      for (const ev of workerRecord.events) sendFrame(raw, ev);

      if (workerRecord.finishedAt) {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        raw.end();
        return;
      }

      const onEvent = (ev: WorkerEvent) => sendFrame(raw, ev);
      workerRecord.emitter.on("event", onEvent);

      const onFinished = () => {
        sendFrame(raw, { type: "stream.closed", reason: "worker_finished" });
        cleanup();
      };
      workerRecord.emitter.once("finished", onFinished);

      const heartbeat = setInterval(() => sendFrame(raw, { type: "heartbeat" }), 15_000);

      let closed = false;
      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        workerRecord.emitter.off("event", onEvent);
        workerRecord.emitter.off("finished", onFinished);
        raw.end();
      }

      req.raw.on("close", cleanup);
    }
  );
};
