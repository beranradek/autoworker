# Implementační plán: Issues Orchestrator

Spec: `2026-05-28-issue-orchestrator-spec.md`

---

## Přehled změn

Stávající `run-once.ts` jen hledá otevřené issues a spouští implementující Worker. Nahradíme ho **deterministickým orchestrátorem** se třemi kroky (v tomto pořadí v každém cyklu):

1. **PR_MERGE** – zamerguj approved PR, zavři issue
2. **PR_REVIEW** – spusť PR Review Worker, přesuň do `pr_reviewed` po úspěšném dokončení review bez nutnosti eskalace na člověka
3. **IMPLEMENTATION** – spusť Implementation Worker pro `open` issues (stávající logika)

Přidáme abstraktní servisní vrstvu pro správu issues (GitHub nyní, GitLab/Jira v budoucnu).

---

## Fáze 1 – Abstraktní model a servisní rozhraní

### `src/issues/model.ts` *(nový)*

```typescript
export type IssueState =
  | 'open'
  | 'in_progress'
  | 'pr_created'
  | 'pr_reviewed'
  | 'closed';

export type CloseReason = 'completed' | 'not_planned' | 'duplicate';
export type PrReviewOutcome = 'approved' | 'rejected' | 'human_needed';

export type Issue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  prReviewOutcome?: PrReviewOutcome;
};

export type PrInfo = {
  number: number;
  url: string;
  branch: string;       // head branch jméno
  diffUrl: string;      // URL diff nebo samotný diff text
  baseBranch: string;   // typicky "main"
};
```

### `src/issues/service.ts` *(nový)*

```typescript
export interface IssueService {
  /** Vrátí issues v daném stavu (dle labelů). */
  listIssuesByState(state: IssueState): Promise<Issue[]>;

  /** Přidá příslušný label / uzavře issue podle nového stavu. */
  transitionTo(
    issue: Issue,
    newState: IssueState,
    opts?: { closeReason?: CloseReason; prReviewOutcome?: PrReviewOutcome }
  ): Promise<void>;

  /** Najde PR prolinkovaný k issue (dle timeline/search). Vrátí null, pokud žádný. */
  findLinkedPr(issue: Issue): Promise<PrInfo | null>;

  /** Zamerguje PR. */
  mergePr(pr: PrInfo): Promise<void>;

  /** True, pokud issue obsahuje mention workera. */
  isMentionedByWorker(issue: Issue): Promise<boolean>;

  /** True, pokud PR review již bylo dispatchováno (zabraňuje dvojímu spuštění). */
  isPrReviewDispatched(issue: Issue): Promise<boolean>;

  /** Označí issue jako "review bylo odesláno" (přidá label). */
  markPrReviewDispatched(issue: Issue): Promise<void>;
}
```

---

## Fáze 2 – GitHub implementace

### `src/issues/github-service.ts` *(nový)*

Implementuje `IssueService` přes Octokit.

**Mapování stavů → GitHub labels:**

| IssueState      | Label (konfigurovaný)        |
|-----------------|------------------------------|
| `open`          | *(žádný)*                    |
| `in_progress`   | `LABEL_IN_PROGRESS`          |
| `pr_created`    | `LABEL_PR_CREATED`           |
| `pr_reviewed`   | `LABEL_PR_REVIEWED`          |
| `closed`        | GitHub closed state          |
| `human_needed`  | `LABEL_HUMAN_NEEDED` (+ `pr_reviewed` label, issue zůstává open) |

**`listIssuesByState`:** volá `octokit.issues.listForRepo` a filtruje dle labelů, přesunuje logiku z `github/issues.ts`.

**`findLinkedPr`:** viz sekce *Rešerše: GitHub linked PR discovery* níže – používá GraphQL `timelineItems` s `ConnectedEvent` + `CrossReferencedEvent`, filtruje OPEN PR.

**`mergePr`:** `octokit.pulls.merge({ merge_method: 'squash' })`.

**`isPrReviewDispatched`:** ověří, zda issue má `LABEL_PR_REVIEW_DISPATCHED`.

**`markPrReviewDispatched`:** přidá label `LABEL_PR_REVIEW_DISPATCHED`.

Stávající funkce v `src/github/issues.ts` zůstanou jako pomocné funkce; `GitHubIssueService` je interně používá nebo reimplementuje dle potřeby.

---

## Fáze 3 – Konfigurace

### `src/config.ts` – přidat do schématu:

```typescript
// Orchestration steps
STEP_PR_MERGE:      boolean default false
STEP_PR_REVIEW:     boolean default true
STEP_IMPLEMENTATION: boolean default true

// New labels
LABEL_PR_CREATED:           string default 'pr-created'
LABEL_PR_REVIEWED:          string default 'pr-reviewed'
LABEL_HUMAN_NEEDED:         string default 'human-needed'
LABEL_PR_REVIEW_DISPATCHED: string default 'pr-review-dispatched'

// Worker image pro PR review (volitelně samostatný, fallback na WORKER_IMAGE)
PR_REVIEW_WORKER_IMAGE: string optional
```

---

## Fáze 4 – Job runner: sjednocení na async + logy

### Asynchronní model pro oba runnery

Oba runnery (local-docker i ACA) fungují **fire-and-forget**: spustí kontejner a ihned vrátí. Worker sám provede všechny state transitions přes GitHub API (labely). Orchestrátor nečeká na dokončení.

Důsledky:
- Odpadá `inFlight` tracking a `MAX_CONCURRENT_WORKERS` wait loop v `run-once.ts` (celý ten blok se smaže)
- `MAX_ACCEPT_PER_RUN` zůstává jako limit *počtu nově dispatchovaných* workerů za jeden cyklus
- Ochrana před double-dispatch: labely na issue (`in-progress`, `pr-review-dispatched`)

### `src/job-runner/local-docker.ts` – async spouštění

```typescript
const child = spawn('docker', args, {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true
});
// Logy do souboru (volitelně) + docker logs dostupné přes container name/id
child.unref();
return { runner: 'local-docker' };
```

**Logování**: kontejner spustit s `--name` (odvozené z `correlationId`) a `--log-driver json-file` (výchozí Docker chování). Tím jsou logy dostupné přes `docker logs <name>`. Volitelně přidat `-v /var/log/autoworker:/logs` mount a worker zapisuje do `/logs/<correlationId>.log` – pak čitelné i jako soubory z hostu.

Konkrétně: přidat do `args`:
- `--name`, sanitized `correlationId` (max 63 znaků, jen `[a-z0-9-]`)
- Bez explicitního `--log-driver` – výchozí `json-file` stačí pro `docker logs`

### `src/job-runner/types.ts` – přidat typy pro PR review:

```typescript
export type PrReviewRunInput = {
  issueUrl: string;
  prUrl: string;
  prBranch: string;
  baseBranch: string;
  githubToken: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  azureApiKey?: string;
  azureResourceName?: string;
  workerImage: string;
  correlationId: string;
  llmModel?: string;
};

export type PrReviewRunResult = {
  runner: 'local-docker' | 'aca';
  jobName?: string;
};
```

Rozšířit `JobRunner` interface o:
```typescript
runPrReview(input: PrReviewRunInput): Promise<PrReviewRunResult>;
```

Přejmenovat `IssueRunInput` → `ImplementationRunInput` (odstraňuje nejednoznačnost, žádná zpětná kompatibilita není potřeba).

### `src/job-runner/local-docker.ts` – `runPrReview`:

Stejný async pattern jako `runIssue` (po refaktoru), navíc env vars:
- `WORKER_MODE=pr-review`
- `PR_URL`, `PR_BRANCH`, `BASE_BRANCH`, `ISSUE_URL`

### `src/job-runner/aca.ts` – `runPrReview`:

Stejný pattern jako `runIssue`, navíc výše zmíněné env vars.

---

## Fáze 5 – Orchestrátor

### `src/runner/orchestrate.ts` *(nový)*

```typescript
export async function runOrchestration(
  service: IssueService,
  runner: JobRunner,
  cfg: Config
): Promise<void>
```

**Krok 1 – PR_MERGE** (pokud `cfg.STEP_PR_MERGE`):
1. `issues = await service.listIssuesByState('pr_reviewed')`
2. Filtrovat ven issues s `human_needed` labelem (ty se nespracovávají)
3. Pro každé issue:
   - `pr = await service.findLinkedPr(issue)`
   - Pokud PR nenalezen → log warn, skip
   - `await service.mergePr(pr)`
   - `await service.transitionTo(issue, 'closed', { closeReason: 'completed' })`

**Krok 2 – PR_REVIEW** (pokud `cfg.STEP_PR_REVIEW`):
1. `issues = await service.listIssuesByState('pr_created')`
2. Filtrovat ven issues, které mají `pr-review-dispatched` label (worker byl již spuštěn, čekáme)
3. Pro každé issue:
   - `pr = await service.findLinkedPr(issue)`
   - Pokud PR nenalezen → log warn, skip
   - `await service.markPrReviewDispatched(issue)`
   - `await runner.runPrReview({ ... pr, issue context ... })`
   - Worker zajistí vlastní state transition (přidá `pr-reviewed` / `human-needed` label)

**Krok 3 – IMPLEMENTATION** (pokud `cfg.STEP_IMPLEMENTATION`):
1. `issues = await service.listIssuesByState('open')`
2. Filtrovat ven issues bez `@worker` mention
3. Filtrovat ven issues, kde `isMentionedByWorker` vrátí false
4. Pro každé issue (s limitem `MAX_ACCEPT_PER_RUN`):
   - `await service.transitionTo(issue, 'in_progress')`
   - `await runner.runIssue({ ... issue context ... })`

### `src/runner/run-once.ts` – refaktorovat:

Stávající logiku přesunout do orchestrátoru. `runOnce` bude:
1. Inicializovat Octokit + runner (jako dnes)
2. Pro každé repo vytvořit `GitHubIssueService`
3. Zavolat `runOrchestration(service, runner, cfg)`

---

## Fáze 6 – PR Review Worker (konvence)

Worker container (není součástí tohoto repozitáře, ale orchestrátor na něj závisí) musí při `WORKER_MODE=pr-review`:

1. Naklonovat repo na větvi `PR_BRANCH`
2. Provést AI review (dle `ISSUE_URL` + PR kontextu)
3. Případné opravy commitovat a pushnout
4. Přidat label `pr-reviewed` nebo `human-needed` na issue přes GitHub API
5. Odebrat label `pr-review-dispatched`

Tato konvence musí být zdokumentovaná (v README nebo WORKER_API.md).

---

## Pořadí implementace

1. `src/issues/model.ts`
2. `src/issues/service.ts`
3. `src/config.ts` (nové config klíče)
4. `src/issues/github-service.ts`
5. `src/job-runner/types.ts` (PrReviewRunInput + interface)
6. `src/job-runner/local-docker.ts` (runPrReview)
7. `src/job-runner/aca.ts` (runPrReview)
8. `src/runner/orchestrate.ts`
9. `src/runner/run-once.ts` (refaktor na orchestrátor)
10. Testy pro `github-service.ts` a `orchestrate.ts`

---

## Rešerše: GitHub linked PR discovery

Provedeno průzkumem skutečných PR/issues v repozitáři `etnetera/waulter` (issue #8, PRs #12, #14, #17).

### Co existuje v praxi

| Mechanismus | PR #12/#14 | PR #17 | Popis |
|---|:---:|:---:|---|
| `Fixes #N` v PR body | ✅ | ❌ | Klasický closing keyword |
| REST `cross-referenced` event | ✅ | ❌ | `GET /issues/{n}/timeline` – obsahuje `source.issue.pull_request.url` |
| REST `connected` event | ❌ | ✅ | `GET /issues/{n}/timeline` – **neobsahuje** PR details! |
| GraphQL `CrossReferencedEvent` | ✅ | ❌ | Plné PR info včetně `headRefName` |
| GraphQL `ConnectedEvent` | ❌ | ✅ | Plné PR info včetně `headRefName` |
| GraphQL `closingIssuesReferences` (na PR) | ✅ | ✅ | Inverse lookup: PR → linked issues |

**Klíčový nález**: PR #17 byl vytvořen Claude agentem bez `Fixes #N` v body. Je linked přes `ConnectedEvent` (API link). REST timeline pro `connected` event nevrátí PR details – **nutno použít GraphQL**.

### Doporučená implementace `findLinkedPr`

Použít GraphQL `timelineItems` na issue straně:

```graphql
query FindLinkedPr($owner: String!, $repo: String!, $issue: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issue) {
      timelineItems(first: 25, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on ConnectedEvent {
            subject {
              ... on PullRequest {
                number
                url
                headRefName
                baseRefName
                state
              }
            }
          }
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                number
                url
                headRefName
                baseRefName
                state
              }
            }
          }
        }
      }
    }
  }
}
```

Filtrovat výsledky kde `state === 'OPEN'`. Pokud více OPEN PRs → vzít nejnovější (nebo logovat warning).

Octokit GraphQL: `octokit.graphql(query, { owner, repo, issue: issueNumber })`.

### Worker konvence: PR body `Fixes #N`

Worker MUSÍ zapsat do PR body `Fixes #<issue_number>` (closing keyword). Důvody:

1. GitHub automaticky uzavře issue při mergi PR – konzistentní UX
2. Fallback pro REST timeline (cross-referenced event) pokud GraphQL selže
3. Standard GitHub konvence viditelná v UI
4. `closingIssuesReferences` GraphQL funguje pro oba mechanismy

PR #17 je výjimka (starší Claude Code styl bez `Fixes #N`). Nové PR Review Worker a Implementation Worker musí tuto konvenci dodržovat.

### Merge a `state_reason`

Při mergi PR s `Fixes #N` GitHub automaticky uzavře issue, ale `state_reason` nenastaví explicitně.
Orchestrátor po `mergePr` zavolá:
```
PATCH /repos/{owner}/{repo}/issues/{issue_number}
{ "state": "closed", "state_reason": "completed" }
```
→ `octokit.issues.update({ state: 'closed', state_reason: 'completed' })`

---

## Rozhodnutá nastavení

- **Merge method**: squash merge jako výchozí, konfigurovatelný přes `PR_MERGE_METHOD` env var (`squash` | `merge` | `rebase`, default `squash`).
- **Stávající labely**: `LABEL_ACCEPTED` a `LABEL_DONE` se odstraní, žádná zpětná kompatibilita. `in_progress` nahrazuje `accepted`, uzavření GitHub issue (state `closed`) nahrazuje `done`.
