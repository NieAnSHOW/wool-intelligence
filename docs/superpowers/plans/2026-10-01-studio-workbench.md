# Studio 内容工作台（P0）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `PRD.md` §7/§9/§10/§12(P0-06..P0-10)/§17 交付 Admin 内容工作台：从文章/事实创建任务、生成平台草稿、人工审核、JSON/Markdown 导出，全部复用现有约定。

**Architecture:** 三张新表（`studio_tasks`/`studio_drafts`/`studio_exports`，迁移 0039）+ 后端 `packages/backend/src/admin/studio.ts`（任务/审核/导出）与 `packages/backend/src/jobs/studio.ts`（生成任务）+ `apps/api` 的 `registerAdmin` 追加路由 + worker 注册 + `/admin/studio` 两个页面。事实（`facts`）只读；草稿不回写事实；导出即时生成不落盘。

**Tech Stack:** Node 24 直跑 TypeScript、postgres.js、pg-boss、Fastify、React Router v7（`Route` typegen）、zod（仅 backend）、node --test。

**边界（必须遵守）：**
- 命名用 `studio`；`packages/backend/src/editorial/` 是站点文章分析模块，禁止放入或复用其目录名（PRD §7 命名边界）。
- 模型调用只走 `chatJson()`（回执+预算已内置）；页面不调模型；测试不访问外部服务（安全阀关闭）。
- 乐观锁用整数 `version` + `Conflict`（`packages/backend/src/admin/sources.ts`），409 由 `adminHandler` 统一映射。
- 本计划不含行业包内容适配（站名/信源/提示词口径需 PRD §16 的用户决策，另立计划）。

**全程命令**（每个任务末尾按需执行；数据库名必须 `*_test` 结尾）：

```bash
export TEST_DB=postgres://127.0.0.1:5432/studio_test
npm run typecheck
$TEST_DB 环境下: DATABASE_URL=$TEST_DB node scripts/migrate.ts
DATABASE_URL=$TEST_DB npm test
```

---

### Task 1: 契约类型 `packages/contracts/src/studio.ts`

**Files:**
- Create: `packages/contracts/src/studio.ts`

contracts 是纯类型/常量包（无 zod），经 package.json 的 `"./*": "./src/*.ts"` subpath 以 `@aihot/contracts/studio` 引用。无需测试文件，typecheck 即验证。

- [ ] **Step 1: 写类型文件**

```ts
// Studio workbench contracts shared by api, web and worker (PRD.md §7/§9/§10). Pure types and
// constants only; runtime validation (zod) lives in packages/backend.
export type StudioTaskStatus = "draft" | "in_progress" | "needs_review" | "approved" | "exported" | "archived";
export type StudioDraftStatus = "generated" | "needs_review" | "approved" | "rejected" | "exported";
export type StudioPriority = "normal" | "urgent" | "expiring";
export type StudioExportFormat = "json" | "markdown";

export const STUDIO_PLATFORMS = ["topic", "xiaohongshu", "douyin", "wechat", "community"] as const;
export type StudioPlatform = (typeof STUDIO_PLATFORMS)[number];

export interface StudioSourceRef {
  kind: "article" | "fact" | "story" | "report";
  id: string;
}

/** Frozen at task creation. facts are immutable except merge (story_id+updated_at), so an
 *  updatedAt mismatch is exactly "the fact moved". */
export interface StudioFactSnapshotEntry {
  factId: number;
  updatedAt: string;
}

/** The package a Skill or a human receives from POST /api/admin/studio/tasks/:id/export. */
export interface StudioExportPackage {
  schemaVersion: 1;
  taskId: string;
  platform: StudioPlatform;
  angle: string;
  audience: string;
  facts: Array<{
    factId: number;
    title: string;
    provider: string | null;
    benefit: string | null;
    conditions: string | null;
    verifiedAt: string;
    sourceUrl: string | null;
  }>;
  draft: { title: string; body: string; tags: string[]; openQuestions: string[]; risks: string[] };
  citations: Array<{ factId: number | null; articleUrl: string | null; note: string | null }>;
  generatedAt: string;
  model: string;
  promptVersion: string;
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 全部通过。

- [ ] **Step 3: Commit**

```bash
git add packages/contracts/src/studio.ts
git commit -m "feat(studio): shared contracts for the admin content workbench"
```

---

### Task 2: 迁移 `database/migrations/0039_studio.sql`

**Files:**
- Create: `database/migrations/0039_studio.sql`

目录最新 0038（0012/0025/0035 为缺号）；`scripts/migrate.ts` 按字典序执行、每文件一个事务。

- [ ] **Step 1: 写迁移**

```sql
-- Studio workbench (PRD §7): admin-side content tasks cut from selected material, their platform
-- drafts and export records. Facts/articles/stories are read-only inputs; drafts never write back.
CREATE TABLE studio_tasks (
  id               text PRIMARY KEY,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  angle            text NOT NULL DEFAULT '',
  audience         text NOT NULL DEFAULT '',
  target_platforms jsonb NOT NULL DEFAULT '[]',
  source_refs      jsonb NOT NULL DEFAULT '[]',
  fact_snapshot    jsonb NOT NULL DEFAULT '[]',
  priority         text NOT NULL DEFAULT 'normal',
  version          integer NOT NULL DEFAULT 1,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

CREATE INDEX studio_tasks_status_idx ON studio_tasks (status, updated_at DESC);

CREATE TABLE studio_drafts (
  id             text PRIMARY KEY,
  task_id        text NOT NULL REFERENCES studio_tasks (id) ON DELETE CASCADE,
  platform       text NOT NULL,
  version        integer NOT NULL,
  status         text NOT NULL DEFAULT 'generated',
  content        jsonb NOT NULL,
  citations      jsonb NOT NULL DEFAULT '[]',
  model          text NOT NULL,
  prompt_version text NOT NULL,
  input_snapshot jsonb,
  review_reason  text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, platform, version)
);

CREATE INDEX studio_drafts_task_idx ON studio_drafts (task_id, created_at DESC);

CREATE TABLE studio_exports (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES studio_tasks (id) ON DELETE CASCADE,
  draft_id     text NOT NULL REFERENCES studio_drafts (id) ON DELETE CASCADE,
  format       text NOT NULL,
  payload_hash text NOT NULL,
  exported_by  text NOT NULL,
  exported_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX studio_exports_task_idx ON studio_exports (task_id, exported_at DESC);
```

- [ ] **Step 2: 建测试库并执行迁移**

```bash
createdb studio_test 2>/dev/null; DATABASE_URL=postgres://127.0.0.1:5432/studio_test node scripts/migrate.ts
```
Expected: 输出包含 0039，无错误。

- [ ] **Step 3: 验证表存在**

```bash
psql postgres://127.0.0.1:5432/studio_test -c '\d studio_tasks' -c '\d studio_drafts' -c '\d studio_exports'
```
Expected: 三表结构如上。

- [ ] **Step 4: Commit**

```bash
git add database/migrations/0039_studio.sql
git commit -m "feat(studio): 0039 migration for tasks, drafts and exports"
```

---

### Task 3: 任务 CRUD `packages/backend/src/admin/studio.ts`（TDD）

**Files:**
- Create: `packages/backend/src/admin/studio.ts`
- Test: `tests/studio.test.ts`

复用：`Conflict`（`admin/sources.ts`）、`audit`（`admin/auth.ts`）、`newShortId`（`lib/ids.ts`）。合法输入校验错误用 `Object.assign(new Error(...), { statusCode: 400 })`（`adminHandler` 映射 400）。

- [ ] **Step 1: 写失败测试**

```ts
// Studio workbench invariants (PRD §7/§9): a task freezes its facts' updatedAt; a stale version
// edit is rejected; merge-moved facts show up as drift. Model generation is covered elsewhere.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createStudioTask, studioTaskDetail, updateStudioTask } from "@aihot/backend/admin/studio";

const actor = "admin:1";
const newFact = async () => (await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`pub-${tag()}`}, ${`事实 ${tag()}`}) RETURNING id`)[0]!.id;

after(async () => {
  await closeDb();
});

test("a task freezes fact timestamps and reports drift after a merge-style update", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const before = await studioTaskDetail(id);
  assert.equal(before!.staleFacts.length, 0);
  assert.equal(before!.task.version, 1);

  await sql`UPDATE facts SET story_id = 1, updated_at = now() WHERE id = ${factId}`;
  const after_ = await studioTaskDetail(id);
  assert.deepEqual(after_!.staleFacts, [factId]);
});

test("editing with a stale version is a conflict, not a silent overwrite", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const first = await updateStudioTask(id, { patch: { angle: "省钱" }, version: 1, reason: "定角度" }, actor);
  assert.equal(first!.version, 2);
  await assert.rejects(
    updateStudioTask(id, { patch: { angle: "避坑" }, version: 1, reason: "旧版本重放" }, actor),
    (e: Error & { code?: string }) => e.code === "conflict",
  );
});

test("source refs must contain at least one entry", async () => {
  await assert.rejects(
    createStudioTask({ title: "空", sourceRefs: [] }, actor),
    (e: Error & { statusCode?: number }) => e.statusCode === 400,
  );
});
```

- [ ] **Step 2: 运行确认失败**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test`
Expected: FAIL，`Cannot find package .../admin/studio`。

- [ ] **Step 3: 实现（本任务只做任务 CRUD；草稿与导出在 Task 6）**

```ts
// Studio workbench administration (PRD §7): content tasks cut from selected material. Facts are
// read-only inputs frozen at creation; drafts never write back to facts or publications.
import { z } from "zod";
import { sql } from "../db.ts";
import { newShortId } from "../lib/ids.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import type { StudioFactSnapshotEntry, StudioSourceRef } from "@aihot/contracts/studio";

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

const SourceRefSchema = z.object({ kind: z.enum(["article", "fact", "story", "report"]), id: z.string().min(1) });

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  angle: z.string().trim().max(200).optional(),
  audience: z.string().trim().max(100).optional(),
  targetPlatforms: z.array(z.string().min(1)).max(8).optional(),
  priority: z.enum(["normal", "urgent", "expiring"]).optional(),
  sourceRefs: z.array(SourceRefSchema).min(1).max(20),
});

const TaskPatchSchema = z.object({
  title: z.string().trim().min(1).max(200),
  angle: z.string().trim().max(200),
  audience: z.string().trim().max(100),
  targetPlatforms: z.array(z.string().min(1)).max(8),
  priority: z.enum(["normal", "urgent", "expiring"]),
  status: z.enum(["draft", "in_progress", "needs_review", "approved", "exported", "archived"]),
}).partial().strict();

async function snapshotFacts(refs: StudioSourceRef[]): Promise<StudioFactSnapshotEntry[]> {
  const ids = refs.filter((r) => r.kind === "fact").map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const rows = await sql<{ id: number; updated_at: Date }[]>`SELECT id, updated_at FROM facts WHERE id IN ${sql(ids)}`;
  return rows.map((r) => ({ factId: r.id, updatedAt: r.updated_at.toISOString() }));
}

export async function createStudioTask(input: unknown, actor: string) {
  const b = CreateTaskSchema.parse(input);
  const id = newShortId();
  const factSnapshot = await snapshotFacts(b.sourceRefs);
  await sql`INSERT INTO studio_tasks (id, title, angle, audience, target_platforms, source_refs, fact_snapshot, priority, created_by)
            VALUES (${id}, ${b.title}, ${b.angle ?? ""}, ${b.audience ?? ""}, ${sql.json(b.targetPlatforms ?? [] as never)}, ${sql.json(b.sourceRefs as never)},
                    ${sql.json(factSnapshot as never)}, ${b.priority ?? "normal"}, ${actor})`;
  await audit(actor, "studio.task.create", `studio-task:${id}`, null, null, { title: b.title, sourceRefs: b.sourceRefs });
  return { id };
}

export async function listStudioTasks(f: { status?: string; q?: string } = {}) {
  const q = f.q?.trim() ? `%${f.q.trim()}%` : null;
  return {
    rows: await sql`
      SELECT t.id, t.title, t.status, t.angle, t.priority, t.version, t.target_platforms, t.created_at, t.updated_at,
             (SELECT count(*)::int FROM studio_drafts d WHERE d.task_id = t.id) AS drafts,
             (SELECT max(d.created_at) FROM studio_drafts d WHERE d.task_id = t.id) AS last_draft_at
      FROM studio_tasks t
      WHERE (${q}::text IS NULL OR t.title ILIKE ${q} OR t.id ILIKE ${q})
        AND (${f.status ?? null}::text IS NULL OR t.status = ${f.status ?? null})
      ORDER BY t.updated_at DESC LIMIT 100`,
  };
}

export async function studioTaskDetail(id: string) {
  const [task] = await sql`SELECT * FROM studio_tasks WHERE id = ${id}`;
  if (!task) return null;
  const drafts = await sql`SELECT id, platform, version, status, content, citations, model, prompt_version, review_reason, created_at
                           FROM studio_drafts WHERE task_id = ${id} ORDER BY created_at DESC`;
  const snapshot = task.fact_snapshot as StudioFactSnapshotEntry[];
  const current = snapshot.length
    ? await sql<{ id: number; updated_at: Date }[]>`SELECT id, updated_at FROM facts WHERE id IN ${sql(snapshot.map((s) => s.factId))}`
    : [];
  const now = new Map(current.map((r) => [r.id, r.updated_at.toISOString()]));
  const staleFacts = snapshot.filter((s) => now.get(s.factId) !== s.updatedAt).map((s) => s.factId);
  const refs = task.source_refs as StudioSourceRef[];
  const articles = refs.filter((r) => r.kind === "article").length
    ? await sql`SELECT id, title, url FROM articles WHERE id IN ${sql(refs.filter((r) => r.kind === "article").map((r) => r.id))}`
    : [];
  const facts = refs.filter((r) => r.kind === "fact").length
    ? await sql`
        SELECT id, public_id, title, subject, conditions, updated_at,
               (SELECT a.url FROM fact_articles fa JOIN articles a ON a.id = fa.article_id
                WHERE fa.fact_id = facts.id ORDER BY CASE fa.role WHEN 'primary' THEN 0 WHEN 'report' THEN 1 ELSE 2 END LIMIT 1) AS source_url
        FROM facts WHERE id IN ${sql(refs.filter((r) => r.kind === "fact").map((r) => Number(r.id)))}`
    : [];
  return { task, drafts, staleFacts, articles, facts };
}

export async function updateStudioTask(id: string, input: { patch: unknown; version: number; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw bad("reason is required");
  const p = TaskPatchSchema.parse(input.patch);
  const [before] = await sql`SELECT * FROM studio_tasks WHERE id = ${id}`;
  if (!before) return null;
  const [after] = await sql`
    UPDATE studio_tasks SET
      title = coalesce(${p.title ?? null}, title),
      angle = coalesce(${p.angle ?? null}, angle),
      audience = coalesce(${p.audience ?? null}, audience),
      target_platforms = CASE WHEN ${p.targetPlatforms === undefined} THEN target_platforms ELSE ${sql.json((p.targetPlatforms ?? []) as never)} END,
      priority = coalesce(${p.priority ?? null}, priority),
      status = coalesce(${p.status ?? null}, status),
      archived_at = CASE WHEN ${p.status ?? null}::text = 'archived' THEN now() ELSE archived_at END,
      version = version + 1, updated_at = now()
    WHERE id = ${id} AND version = ${input.version} RETURNING *`;
  if (!after) throw new Conflict("这个任务已被修改，请刷新后再操作");
  await audit(actor, "studio.task.update", `studio-task:${id}`, input.reason, { version: before.version, ...p }, { version: after.version });
  return after;
}
```

注意：`zod` 的 `.parse` 抛 `ZodError`（`adminHandler` 不会映射为 400）。在 `createStudioTask`/`updateStudioTask` 入口把 `ZodError` 换成 `bad(...)`：

```ts
const parseOr400 = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const r = schema.safeParse(input);
  if (!r.success) throw bad(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300));
  return r.data;
};
```

用 `parseOr400(CreateTaskSchema, input)` / `parseOr400(TaskPatchSchema, input.patch)` 替换两处 `.parse`。

- [ ] **Step 4: 运行测试通过**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test`
Expected: PASS（含既有全部测试）。

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/admin/studio.ts tests/studio.test.ts
git commit -m "feat(studio): content tasks with frozen fact snapshots and version conflicts"
```

---

### Task 4: 模型能力与提示词

**Files:**
- Modify: `packages/backend/src/editorial/models.ts`（`CAPABILITIES` 对象内加一行）
- Create: `industry/prompts/studio-draft.md`

- [ ] **Step 1: 注册能力（`models.ts` 的 `CAPABILITIES` 末尾、`monitor` 行后加）**

```ts
  studioDraft: { label: "内容工作台草稿（从事实快照写平台草稿，只准用给出的事实）", env: "STUDIO_DRAFT_MODEL", default: "default", purposes: ["studio.draft"] },
```

- [ ] **Step 2: 写提示词 `industry/prompts/studio-draft.md`**

```markdown
你是「{{siteName}}」内容工作台的草稿写手。根据用户给出的事实卡，为指定平台写一篇中文草稿。

规则：
- 只使用事实卡里明确写出的数字、日期、价格、额度和条件；缺失的字段一律写「未公开」，禁止推测或补全。
- 每个关键数字、日期或条件后面用 [事实n] 标注来源。
- 禁止使用「无限」「永久」「保证」「必得」等承诺性表述。
- 必须提示适用的限制与风险（地区、实名、支付方式、自动续费、资格条件等，事实卡有则写，没有则写「限制未公开」）。
- 不提供批量注册、多账号、绕过平台风控之类的建议。
- 标题不超过 20 个字，不加夸张标点。

只输出 JSON 对象：
{"titleCandidates":["…","…","…"],"body":"正文","tags":["标签"],"openQuestions":["无法从事实卡确认、需要人工核实的问题"],"risks":["风险与限制提示"]}
```

- [ ] **Step 3: 验证提示词可加载与版本化**

```bash
node --env-file=.env -e 'import("@aihot/backend/editorial/prompts").then(m => console.log(m.promptText("studio-draft").slice(0, 40), "|", m.promptVersion("studio-draft")))' 2>/dev/null || node -e 'const m = await import("./packages/backend/src/editorial/prompts.ts"); console.log(m.promptText("studio-draft").slice(0,40), "|", m.promptVersion("studio-draft"))'
```
Expected: 输出提示词开头（含站名替换）和 `studio-draft@<hash>`。

- [ ] **Step 4: Commit**

```bash
git add packages/backend/src/editorial/models.ts industry/prompts/studio-draft.md
git commit -m "feat(studio): draft capability and industry prompt"
```

---

### Task 5: 生成任务 `packages/backend/src/jobs/studio.ts`（TDD）

**Files:**
- Create: `packages/backend/src/jobs/studio.ts`
- Modify: `packages/backend/src/jobs/queue.ts`（`QUEUES` + `QUEUE_OPTIONS` 各一行）
- Test: 新建 `tests/studio-jobs.test.ts`（自包含，独立于 studio.test.ts）

生成拆成纯函数（`draftInput`）、落库函数（`applyGeneration`，可脱离模型测试）与付费调用（`generateStudioDraft`，只在 worker 里跑，测试不触达）。幂等：重跑产出新 `version`，不覆盖旧草稿。

- [ ] **Step 1: 在 `queue.ts` 的 `QUEUES` 加 `studioDraft: "studio.draft",`；`QUEUE_OPTIONS` 加**

```ts
  [QUEUES.studioDraft]: { policy: "short", retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 },
```

- [ ] **Step 2: 新建独立测试文件 `tests/studio-jobs.test.ts`（自包含头部；不与 studio.test.ts 共享文件，便于并行任务）**

```ts
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createStudioTask } from "@aihot/backend/admin/studio";
import { applyGeneration, draftInput } from "@aihot/backend/jobs/studio";

const actor = "admin:1";
const newFact = async () => (await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`pub-${tag()}`}, ${`事实 ${tag()}`}) RETURNING id`)[0]!.id;

after(async () => {
  await closeDb();
});

test("applyGeneration bumps the platform draft version and moves the task to review", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const out = { titleCandidates: ["标题一"], body: "正文", tags: [], openQuestions: [], risks: ["限制未公开"] };
  const first = await applyGeneration(id, "xiaohongshu", out, "default", "studio-draft@t", actor);
  const second = await applyGeneration(id, "xiaohongshu", out, "default", "studio-draft@t", actor);
  assert.equal(second.version, first.version + 1);
  const [t] = await sql`SELECT status FROM studio_tasks WHERE id = ${id}`;
  assert.equal(t!.status, "needs_review");
});

test("draftInput only uses the frozen facts", async () => {
  const text = draftInput(
    { title: "任务", angle: "省钱", audience: "开发者", platform: "wechat" },
    [{ factId: 1, title: "X 平台每日免费额度", provider: "X", benefit: "每日 100 次", conditions: "新用户", verifiedAt: "2026-10-01T00:00:00+08:00", sourceUrl: "https://example.com/a" }],
  );
  assert.match(text, /事实1/);
  assert.match(text, /每日 100 次/);
  assert.match(text, /平台：wechat/);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test`
Expected: FAIL，`Cannot find package .../jobs/studio`。

- [ ] **Step 4: 实现 `jobs/studio.ts`**

```ts
// Studio draft generation (PRD §7.3): one job per request; the paid call goes through chatJson, so
// receipts, budgets and output rejection are already handled. Re-running yields a new draft version.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sql } from "../db.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { newShortId } from "../lib/ids.ts";
import { chatJson } from "../providers/llm.ts";
import { ensureQueue, QUEUES } from "./queue.ts";
import type { StudioPlatform } from "@aihot/contracts/studio";

export const DraftOutputSchema = z.object({
  titleCandidates: z.array(z.string().min(1)).min(1).max(5),
  body: z.string().min(1),
  tags: z.array(z.string()).max(10).default([]),
  openQuestions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface DraftFactInput {
  factId: number;
  title: string;
  provider: string | null;
  benefit: string | null;
  conditions: string | null;
  verifiedAt: string;
  sourceUrl: string | null;
}

/** The user message: facts only, numbered, with the drift warning the model must repeat. */
export function draftInput(
  task: { title: string; angle: string; audience: string; platform: string },
  facts: DraftFactInput[],
): string {
  const lines = [
    `任务：${task.title}`,
    `角度：${task.angle || "未指定"}`,
    `受众：${task.audience || "未指定"}`,
    `平台：${task.platform}`,
    "",
    "事实卡（只能使用这里的字段；缺失写「未公开」）：",
    ...facts.map(
      (f, i) =>
        `- [事实${i + 1}] ${f.title}｜提供方 ${f.provider ?? "未公开"}｜权益 ${f.benefit ?? "未公开"}｜条件 ${f.conditions ?? "未公开"}｜核验时间 ${f.verifiedAt}｜来源 ${f.sourceUrl ?? "未公开"}`,
    ),
  ];
  if (!facts.length) lines.push("- （无事实卡：拒绝编写数字，只写结构性内容并把问题列入 openQuestions）");
  return lines.join("\n");
}

/** Persists one model (or test) output as the next draft version for the platform. */
export async function applyGeneration(taskId: string, platform: string, out: DraftOutput, model: string, promptVer: string, actor: string, inputSnapshot?: unknown) {
  const id = newShortId();
  const [draft] = await sql`
    INSERT INTO studio_drafts (id, task_id, platform, version, content, citations, model, prompt_version, input_snapshot, created_by)
    VALUES (${id}, ${taskId}, ${platform},
            (SELECT coalesce(max(version), 0) + 1 FROM studio_drafts WHERE task_id = ${taskId} AND platform = ${platform}),
            ${sql.json(out as never)}, '[]'::jsonb, ${model}, ${promptVer}, ${inputSnapshot === undefined ? null : sql.json(inputSnapshot as never)}, ${actor})
    RETURNING id, version`;
  await sql`UPDATE studio_tasks SET status = 'needs_review', updated_at = now() WHERE id = ${taskId}`;
  return draft!;
}

export async function generateStudioDraft(taskId: string, platform: string, actor: string) {
  const [task] = await sql<{ title: string; angle: string; audience: string; fact_snapshot: Array<{ factId: number }> }>`
    SELECT title, angle, audience, fact_snapshot FROM studio_tasks WHERE id = ${taskId}`;
  if (!task) throw new Error(`studio task ${taskId} not found`);
  const ids = task.fact_snapshot.map((s) => s.factId);
  const facts = ids.length
    ? await sql<DraftFactInput[]>`
        SELECT f.id AS "factId", f.title, f.subject AS provider, f.conditions, f.updated_at AS "verifiedAt",
               (SELECT a.url FROM fact_articles fa JOIN articles a ON a.id = fa.article_id WHERE fa.fact_id = f.id
                ORDER BY CASE fa.role WHEN 'primary' THEN 0 WHEN 'report' THEN 1 ELSE 2 END LIMIT 1) AS "sourceUrl"
        FROM facts f WHERE f.id IN ${sql(ids)}`
    : [];
  const input = facts.map((f) => ({
    ...f,
    benefit: f.title,
    verifiedAt: f.verifiedAt.toISOString(),
  }));
  const ver = promptVersion("studio-draft");
  const res = await chatJson({
    model: await modelFor("studioDraft"),
    purpose: "studio.draft",
    subject: `studio-task:${taskId}`,
    promptVersion: ver,
    system: promptText("studio-draft"),
    user: draftInput({ title: task.title, angle: task.angle, audience: task.audience, platform }, input),
    schema: DraftOutputSchema,
    temperature: 0.4,
    maxTokens: 2000,
  });
  return applyGeneration(taskId, platform, res.data, res.model, ver, actor, input);
}

export async function registerStudioJobs(boss: PgBoss) {
  await ensureQueue(QUEUES.studioDraft);
  await boss.work<{ taskId: string; platform: string; actor: string }>(QUEUES.studioDraft, { localConcurrency: 2, pollingIntervalSeconds: 1 }, async ([job]) => {
    if (!job) return;
    await generateStudioDraft(job.data.taskId, job.data.platform as StudioPlatform, job.data.actor);
    return { ok: true };
  });
}
```

- [ ] **Step 5: 运行测试通过**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test && npm run typecheck`
Expected: PASS；typecheck 通过。

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/jobs/studio.ts packages/backend/src/jobs/queue.ts tests/studio.test.ts
git commit -m "feat(studio): paid draft generation job with versioned, idempotent output"
```

---

### Task 6: 草稿编辑 / 审核 / 导出（TDD）

**Files:**
- Modify: `packages/backend/src/admin/studio.ts`
- Test: 新建 `tests/studio-export.test.ts`（自包含头部，独立于 studio.test.ts）

导出即时生成（不落盘），`payload_hash = sha256(stableJson(package)).slice(0, 16)`；`studio_exports` 只记元数据。导出前置条件：draft `approved`。

- [ ] **Step 1: 新建失败测试 `tests/studio-export.test.ts`**

```ts
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createStudioTask } from "@aihot/backend/admin/studio";
import { applyGeneration } from "@aihot/backend/jobs/studio";
import { editStudioDraft, exportStudioPackage, reviewStudioDraft } from "@aihot/backend/admin/studio";

const actor = "admin:1";
const newFact = async () => (await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`pub-${tag()}`}, ${`事实 ${tag()}`}) RETURNING id`)[0]!.id;

after(async () => {
  await closeDb();
});

test("review then export: rejected drafts cannot export, approved ones produce a stable package", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const d1 = await applyGeneration(id, "topic", { titleCandidates: ["A"], body: "b", tags: [], openQuestions: [], risks: [] }, "default", "v", actor);
  await reviewStudioDraft(d1.id, { decision: "reject", reason: "语气太满" }, actor);
  await assert.rejects(exportStudioPackage(id, { draftId: d1.id, format: "json" }, actor), /approved/);

  const d2 = await applyGeneration(id, "topic", { titleCandidates: ["B"], body: "b2", tags: ["t"], openQuestions: ["q"], risks: ["r"] }, "default", "v", actor);
  await reviewStudioDraft(d2.id, { decision: "approve", reason: "核对无误" }, actor);
  const pkg = await exportStudioPackage(id, { draftId: d2.id, format: "json" }, actor);
  assert.equal(pkg.json.schemaVersion, 1);
  assert.ok(pkg.json.facts.length >= 1);
  assert.ok(pkg.json.citations.length >= 1);
  const again = await exportStudioPackage(id, { draftId: d2.id, format: "markdown" }, actor);
  assert.match(again.markdown, /事实卡/);
  const rows = await sql`SELECT count(*)::int AS n FROM studio_exports WHERE task_id = ${id}`;
  assert.equal(rows[0]!.n, 2);
});

test("editing a draft marks it needs_review", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const d = await applyGeneration(id, "wechat", { titleCandidates: ["A"], body: "b", tags: [], openQuestions: [], risks: [] }, "default", "v", actor);
  const edited = await editStudioDraft(d.id, { content: { titleCandidates: ["A2"], body: "b", tags: [], openQuestions: [], risks: [] }, reason: "改标题" }, actor);
  assert.equal(edited.status, "needs_review");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test`
Expected: FAIL，`editStudioDraft` 不存在。

- [ ] **Step 3: 在 `admin/studio.ts` 追加实现**

```ts
import { sha256, stableJson } from "../lib/ids.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import type { DraftOutput } from "../jobs/studio.ts";
import type { StudioExportPackage, StudioPlatform } from "@aihot/contracts/studio";

const DraftContentSchema = z.object({
  titleCandidates: z.array(z.string()).min(1).max(5),
  body: z.string().min(1),
  tags: z.array(z.string()).max(10),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
});

export async function editStudioDraft(id: string, input: { content: unknown; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw bad("reason is required");
  const content = parseOr400(DraftContentSchema, input.content);
  const [after] = await sql`UPDATE studio_drafts SET content = ${sql.json(content as never)}, status = 'needs_review', review_reason = NULL
                            WHERE id = ${id} RETURNING *`;
  if (!after) return null;
  await audit(actor, "studio.draft.edit", `studio-draft:${id}`, input.reason, null, { content });
  return after;
}

export async function reviewStudioDraft(id: string, input: { decision: "approve" | "reject"; reason: string }, actor: string) {
  if (!input.reason?.trim()) throw bad("reason is required");
  return sql.begin(async (tx) => {
    const [draft] = await tx`SELECT * FROM studio_drafts WHERE id = ${id} FOR UPDATE`;
    if (!draft) return null;
    const status = input.decision === "approve" ? "approved" : "rejected";
    const [after] = await tx`UPDATE studio_drafts SET status = ${status}, review_reason = ${input.reason} WHERE id = ${id} RETURNING *`;
    if (status === "approved") {
      await tx`UPDATE studio_tasks SET status = 'approved', version = version + 1, updated_at = now() WHERE id = ${draft.task_id} AND status <> 'exported'`;
    }
    await audit(actor, `studio.draft.${input.decision}`, `studio-draft:${id}`, input.reason, { status: draft.status }, { status });
    return after!;
  });
}

/** Marks the task in_progress and hands the paid work to the worker; the idempotency key from the
 *  admin UI dedupes double clicks (same pattern as /content/:id/rerun). */
export async function queueGeneration(taskId: string, platform: string, requestId: string, actor: string) {
  if (!(await sql`SELECT 1 FROM studio_tasks WHERE id = ${taskId}`).length) return null;
  const parsed = parseOr400(z.enum(["topic", "xiaohongshu", "douyin", "wechat", "community"]), platform);
  await sql`UPDATE studio_tasks SET status = 'in_progress', version = version + 1, updated_at = now() WHERE id = ${taskId}`;
  await enqueue(QUEUES.studioDraft, { taskId, platform: parsed, actor }, requestId ? { singletonKey: `studio-generate:${requestId}` } : {});
  await audit(actor, "studio.task.generate", `studio-task:${taskId}`, null, null, { platform: parsed });
  return { queued: true };
}

function renderMarkdown(pkg: StudioExportPackage): string {
  const lines = [
    `# ${pkg.draft.title}`,
    "",
    `- 平台：${pkg.platform}｜任务 ${pkg.taskId}｜生成 ${pkg.generatedAt}｜${pkg.model} @ ${pkg.promptVersion}`,
    "",
    "## 事实卡",
    ...pkg.facts.map((f, i) => `${i + 1}. ${f.title}（${f.provider ?? "未公开"}）｜${f.benefit ?? "未公开"}｜条件：${f.conditions ?? "未公开"}｜核验 ${f.verifiedAt}${f.sourceUrl ? `｜[来源](${f.sourceUrl})` : ""}`),
    "",
    "## 正文",
    pkg.draft.body,
    "",
    ...(pkg.draft.tags.length ? [`标签：${pkg.draft.tags.join("、")}`, ""] : []),
    ...(pkg.draft.openQuestions.length ? ["## 待人工核实", ...pkg.draft.openQuestions.map((q) => `- ${q}`), ""] : []),
    ...(pkg.draft.risks.length ? ["## 风险与限制", ...pkg.draft.risks.map((r) => `- ${r}`)] : []),
  ];
  return lines.join("\n");
}

export async function exportStudioPackage(taskId: string, input: { draftId: string; format: "json" | "markdown" }, actor: string) {
  const detail = await studioTaskDetail(taskId);
  if (!detail) return null;
  const draft = detail.drafts.find((d) => d.id === input.draftId);
  if (!draft) throw bad("draft not found on this task");
  if (draft.status !== "approved") throw bad("只有审核通过的草稿可以导出");
  const content = draft.content as DraftOutput;
  const pkg: StudioExportPackage = {
    schemaVersion: 1,
    taskId,
    platform: draft.platform as StudioPlatform,
    angle: detail.task.angle,
    audience: detail.task.audience,
    facts: detail.facts.map((f) => ({
      factId: f.id,
      title: f.title,
      provider: f.subject ?? null,
      benefit: f.title,
      conditions: f.conditions ?? null,
      verifiedAt: f.updated_at.toISOString(),
      sourceUrl: f.source_url ?? null,
    })),
    draft: { title: content.titleCandidates[0] ?? "", body: content.body, tags: content.tags ?? [], openQuestions: content.openQuestions ?? [], risks: content.risks ?? [] },
    citations: detail.facts.map((f) => ({ factId: f.id, articleUrl: f.source_url ?? null, note: null })),
    generatedAt: draft.created_at.toISOString(),
    model: draft.model,
    promptVersion: draft.prompt_version,
  };
  const payloadHash = sha256(stableJson(pkg)).slice(0, 16);
  const markdown = renderMarkdown(pkg);
  const id = newShortId();
  await sql`INSERT INTO studio_exports (id, task_id, draft_id, format, payload_hash, exported_by)
            VALUES (${id}, ${taskId}, ${draft.id}, ${input.format}, ${payloadHash}, ${actor})`;
  await sql`UPDATE studio_tasks SET status = 'exported', version = version + 1, updated_at = now() WHERE id = ${taskId}`;
  await sql`UPDATE studio_drafts SET status = 'exported' WHERE id = ${draft.id}`;
  await audit(actor, "studio.task.export", `studio-task:${taskId}`, null, null, { draftId: draft.id, format: input.format, payloadHash });
  return input.format === "json" ? { format: "json", payloadHash, json: pkg } : { format: "markdown", payloadHash, markdown };
}
```

说明：`facts[].benefit` 现阶段取事实标题（`facts` 无独立「权益」列）；是否在 analyses 结构化输出里补权益字段，留给后续行业适配计划（需 PRD §16 用户决策）——导出契约先固定形状。`citations` 由任务引用的事实派生（factId + 首选来源文章 URL），`input_snapshot` 在生成时写入，两列都有真实写入路径。

- [ ] **Step 4: 运行测试通过**

Run: `DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test && npm run typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/admin/studio.ts tests/studio.test.ts
git commit -m "feat(studio): draft review, edit and on-the-fly export packages"
```

---

### Task 7: Admin API 路由

**Files:**
- Modify: `apps/api/src/routes/admin.ts`

`adminHandler` 已统一会话/CSRF/400/409/500；只需注册路由。

- [ ] **Step 1: `admin.ts` 顶部 import 区加**

```ts
import { createStudioTask, editStudioDraft, exportStudioPackage, listStudioTasks, queueGeneration, reviewStudioDraft, studioTaskDetail, updateStudioTask } from "@aihot/backend/admin/studio";
```

- [ ] **Step 2: `registerAdmin` 内追加路由块（`// Runs (F20)` 注释块之前）**

```ts
  // Studio workbench (PRD §10): content tasks, drafts, review and export
  app.get("/api/admin/studio/tasks", adminHandler(async (req) => listStudioTasks({ status: q(req).status, q: q(req).q })));
  app.post("/api/admin/studio/tasks", adminHandler(async (req, _reply, admin) => createStudioTask(body(req), actorOf(admin))));
  app.get("/api/admin/studio/tasks/:id", adminHandler(async (req, reply) => orNotFound(req, reply, await studioTaskDetail(param(req, "id")))));
  app.patch("/api/admin/studio/tasks/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await updateStudioTask(param(req, "id"), body(req), actorOf(admin)))));
  app.post("/api/admin/studio/tasks/:id/generate", adminHandler(async (req, reply, admin) => {
    const b = body<{ platform: string }>(req);
    const requestId = String(req.headers["idempotency-key"] ?? "");
    return orNotFound(req, reply, await queueGeneration(param(req, "id"), b.platform, requestId, actorOf(admin)));
  }));
  app.patch("/api/admin/studio/drafts/:id", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await editStudioDraft(param(req, "id"), body(req), actorOf(admin)))));
  app.post("/api/admin/studio/drafts/:id/review", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await reviewStudioDraft(param(req, "id"), body(req), actorOf(admin)))));
  app.post("/api/admin/studio/tasks/:id/export", adminHandler(async (req, reply, admin) => orNotFound(req, reply, await exportStudioPackage(param(req, "id"), body(req), actorOf(admin)))));
```

- [ ] **Step 3: 类型检查 + 启动 API 冒烟**

```bash
npm run typecheck
# 本地若有 .env：启动 api 后不带会话访问应 401
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/admin/studio/tasks
```
Expected: typecheck 通过；curl 返回 401（未登录）。

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/admin.ts
git commit -m "feat(studio): admin API routes for tasks, drafts, review and export"
```

---

### Task 8: Worker 注册

**Files:**
- Modify: `apps/worker/src/main.ts`

- [ ] **Step 1: import 区加 `import { registerStudioJobs } from "@aihot/backend/jobs/studio";`，`await registerPublicationJobs(boss);` 之后加一行**

```ts
await registerStudioJobs(boss);
```

- [ ] **Step 2: 类型检查与提交**

```bash
npm run typecheck
git add apps/worker/src/main.ts
git commit -m "feat(studio): register the draft generation worker"
```

---

### Task 9: Web 列表页 + 路由 + 侧栏

**Files:**
- Create: `apps/web/app/routes/admin/studio.tsx`
- Modify: `apps/web/app/routes.ts`（admin-layout 块内加一行）
- Modify: `apps/web/app/routes/admin/layout.tsx`（NAV「内容」组加一项）

- [ ] **Step 1: `routes.ts` 的 admin-layout 数组内、`route("admin/content/:id", ...)` 行后加**

```ts
    route("admin/studio", "routes/admin/studio.tsx"),
```

- [ ] **Step 2: `layout.tsx` NAV「内容」组 `admin/content` 项后加**

```ts
      { to: "/admin/studio", label: "内容工作台" },
```

- [ ] **Step 3: 写列表页（创建表单内联，替代 PRD 规划的独立 /new 页）**

```tsx
import { SITE } from "@aihot/industry/site";
import { Link, useNavigate } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/studio";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Textarea, Time } from "../../features/admin/ui";

interface Row {
  id: string;
  title: string;
  status: string;
  angle: string;
  priority: string;
  version: number;
  drafts: number;
  updated_at: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  return adminGet<{ rows: Row[] }>(request, `/api/admin/studio/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}

export const meta: Route.MetaFunction = () => [{ title: `内容工作台 · ${SITE.name} 后台` }];

export default function Studio({ loaderData }: Route.ComponentProps) {
  const { rows } = loaderData;
  const navigate = useNavigate();
  const { run, busy } = useAdminAction();
  const [title, setTitle] = useState("");
  const [refs, setRefs] = useState("");

  const create = async () => {
    // 一行一个引用：fact:123 / article:<id> / story:12
    const sourceRefs = refs.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [kind, id] = l.split(":");
      return { kind, id };
    });
    const res = await run<{ id: string }>("POST", "/api/admin/studio/tasks", { title, sourceRefs }, { label: "create-task" });
    if (res?.id) navigate(`/admin/studio/${res.id}`);
  };

  return (
    <AdminPage title="内容工作台" subtitle="从精选文章或事实创建传播任务，生成草稿、人工审核后导出给外挂 Skill 或人工发布。">
      <Card title="新建任务" className="mb-5">
        <div className="flex max-w-2xl flex-col gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="内部任务名，如「X 平台每日免费额度 · 小红书」" aria-label="任务名" />
          <Textarea rows={3} value={refs} onChange={(e) => setRefs(e.target.value)} placeholder={"引用（每行一个）：\nfact:42\narticle:ck…"} aria-label="来源引用" />
          <Button tone="primary" onClick={create} disabled={busy || !title.trim() || !refs.trim()}>创建并打开</Button>
        </div>
      </Card>
      <Card pad={false} title="任务">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/studio/${r.id}`)}
          empty="还没有任务。从「内容诊断」页找到精选文章或事实，回来建第一个任务。"
          columns={[
            {
              key: "t", label: "任务",
              render: (r) => (
                <div className="min-w-[260px]">
                  <Link to={`/admin/studio/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id} · v{r.version}</div>
                </div>
              ),
            },
            { key: "st", label: "状态", render: (r) => <Badge tone={r.status === "exported" ? "muted" : r.status === "needs_review" ? "warn" : "accent"}>{r.status}</Badge> },
            { key: "a", label: "角度", render: (r) => r.angle || "—" },
            { key: "d", label: "草稿", align: "right", render: (r) => r.drafts },
            { key: "u", label: "更新", render: (r) => <Time at={r.updated_at} /> },
          ]}
        />
      </Card>
      {!rows.length && <Empty>创建第一个任务开始。</Empty>}
    </AdminPage>
  );
}
```

- [ ] **Step 4: 验证**

```bash
npm run build -w @aihot/web && npm run typecheck
```
Expected: 构建通过。

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/routes.ts apps/web/app/routes/admin/layout.tsx apps/web/app/routes/admin/studio.tsx
git commit -m "feat(studio): task list page with inline creation"
```

---

### Task 10: Web 详情页（草稿、审核、导出）

**Files:**
- Create: `apps/web/app/routes/admin/studio-item.tsx`
- Modify: `apps/web/app/routes.ts`（admin-layout 块内、`admin/studio` 行后加 `route("admin/studio/:id", "routes/admin/studio-item.tsx")`）

- [ ] **Step 1: 写详情页**

```tsx
import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import type { Route } from "./+types/studio-item";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Select, Time } from "../../features/admin/ui";
import { STUDIO_PLATFORMS, type StudioExportPackage } from "@aihot/contracts/studio";

interface Draft { id: string; platform: string; version: number; status: string; content: { titleCandidates: string[]; body: string; tags?: string[]; openQuestions?: string[]; risks?: string[] }; model: string; prompt_version: string; created_at: string }
interface Fact { id: number; title: string; subject: string | null; conditions: string | null; updated_at: string }
interface Detail { task: { id: string; title: string; status: string; angle: string; audience: string; version: number }; drafts: Draft[]; staleFacts: number[]; facts: Fact[] }

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Detail>(request, `/api/admin/studio/tasks/${params.id}`);
}

export const meta: Route.MetaFunction = () => [{ title: `任务详情 · ${SITE.name} 后台` }];

const download = (name: string, text: string, type: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export default function StudioItem({ loaderData }: Route.ComponentProps) {
  const { task, drafts, facts, staleFacts } = loaderData;
  const { run, busy } = useAdminAction();
  const [platform, setPlatform] = useState<string>("topic");
  const [reason, setReason] = useState("");

  const generate = async () => {
    await run("POST", `/api/admin/studio/tasks/${task.id}/generate`, { platform }, { label: "generate", success: "已排队生成" });
  };
  const review = async (id: string, decision: "approve" | "reject") => {
    if (!reason.trim()) return;
    await run("POST", `/api/admin/studio/drafts/${id}/review`, { decision, reason }, { label: `review-${id}`, success: "已记录" });
    setReason("");
  };
  const exportAs = async (id: string, format: "json" | "markdown") => {
    const res = await run<{ format: string; payloadHash: string; json?: StudioExportPackage; markdown?: string }>(
      "POST", `/api/admin/studio/tasks/${task.id}/export`, { draftId: id, format }, { label: `export-${id}-${format}` },
    );
    if (!res) return;
    if (format === "json") download(`${task.id}-${res.payloadHash}.json`, JSON.stringify(res.json, null, 2), "application/json");
    else download(`${task.id}-${res.payloadHash}.md`, res.markdown ?? "", "text/markdown");
  };

  return (
    <AdminPage title={task.title} subtitle={`状态 ${task.status} · v${task.version} · 角度 ${task.angle || "未定"} · 受众 ${task.audience || "未定"}`}>
      {staleFacts.length > 0 && (
        <Card title="素材已变化" className="mb-5">
          <p className="text-[13.5px] text-hot">事实 {staleFacts.join("、")} 在任务创建后有更新（可能被合并到别的事件）。先回「内容诊断」核对，再决定是否重新生成草稿。</p>
        </Card>
      )}
      <Card title="事实卡（只读）" className="mb-5">
        {facts.length === 0 && <p className="text-[13.5px] text-ink-3">本任务没有引用事实。</p>}
        {facts.map((f) => (
          <div key={f.id} className="border-b border-line py-2 last:border-0">
            <span className="font-medium">{f.title}</span>
            {staleFacts.includes(f.id) && <Badge tone="warn">已变化</Badge>}
            <div className="text-[12.5px] text-ink-4">条件：{f.conditions ?? "未公开"}｜核验 <Time at={f.updated_at} /></div>
          </div>
        ))}
      </Card>
      <Card title="生成草稿" className="mb-5">
        <div className="flex max-w-md gap-2">
          <Select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="平台">
            {STUDIO_PLATFORMS.map((p) => <option key={p} value={p}>{p}</option>)}
          </Select>
          <Button tone="primary" onClick={generate} disabled={busy}>生成（付费）</Button>
        </div>
      </Card>
      {drafts.map((d) => (
        <Card key={d.id} title={`${d.platform} · v${d.version}`} right={<Badge tone={d.status === "approved" || d.status === "exported" ? "muted" : d.status === "rejected" ? "bad" : "warn"}>{d.status}</Badge>} className="mb-5">
          <div className="mb-2 text-[12.5px] text-ink-4">{d.model} @ {d.prompt_version} · <Time at={d.created_at} /></div>
          <div className="mb-1 text-[13.5px]">标题候选：{d.content.titleCandidates.join("｜")}</div>
          <pre className="whitespace-pre-wrap rounded-control bg-surface p-3 text-[13px]">{d.content.body}</pre>
          {!!d.content.risks?.length && <div className="mt-2 text-[12.5px] text-hot">风险：{d.content.risks.join("；")}</div>}
          {!!d.content.openQuestions?.length && <div className="mt-1 text-[12.5px] text-ink-3">待核实：{d.content.openQuestions.join("；")}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="审核理由（必填）" aria-label="审核理由" />
            <Button onClick={() => review(d.id, "approve")} disabled={busy || !reason.trim() || d.status === "approved"}>通过</Button>
            <Button onClick={() => review(d.id, "reject")} disabled={busy || !reason.trim()}>驳回</Button>
            {d.status === "approved" && <>
              <Button onClick={() => exportAs(d.id, "json")} disabled={busy}>导出 JSON</Button>
              <Button onClick={() => exportAs(d.id, "markdown")} disabled={busy}>导出 Markdown</Button>
            </>}
          </div>
        </Card>
      ))}
    </AdminPage>
  );
}
```

- [ ] **Step 2: 构建与类型检查**

```bash
npm run build -w @aihot/web && npm run typecheck
```
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/routes/admin/studio-item.tsx apps/web/app/routes.ts
git commit -m "feat(studio): task detail page with review and export"
```

---

### Task 11: 运维文档 + 全量验证

**Files:**
- Create: `docs/studio.md`

- [ ] **Step 1: 写简短运维文档（对齐 docs/leaderboard.md 的口吻）**

```markdown
# 内容工作台（`/admin/studio`）

把站内已确认的资讯加工成可审核的自媒体素材：从文章或事实建任务 → Worker 付费生成平台草稿 → 人工审核 → 导出 JSON/Markdown 给外挂 Skill 或人工发布。核心系统不自动发布到任何平台。

- 事实卡是只读输入；任务创建时冻结 `facts.updated_at`，事实被合并或移动后详情页会提示「素材已变化」。
- 生成走 `studioDraft` 模型能力（`/admin/models` 可切换），提示词在 `industry/prompts/studio-draft.md`，版本随内容哈希变化并写入草稿。
- 导出即时生成不落盘；`studio_exports` 只记哈希与操作者。只有 `approved` 草稿可导出。
- 所有写操作有审计（`/admin/audit` 搜 `studio.`）。

**代码**：`packages/backend/src/admin/studio.ts`（任务/审核/导出）、`packages/backend/src/jobs/studio.ts`（生成）、`apps/web/app/routes/admin/studio*.tsx`（页面）。
```

- [ ] **Step 2: 全量验证（PRD §13 运行检查）**

```bash
npm run typecheck
DATABASE_URL=postgres://127.0.0.1:5432/studio_test node scripts/migrate.ts
DATABASE_URL=postgres://127.0.0.1:5432/studio_test npm test
npm run build -w @aihot/web && node --test apps/web/tests/*.test.ts
```
Expected: 全部通过。

- [ ] **Step 3: 冒烟（本地栈可用时）**

```bash
node scripts/smoke.ts --base http://localhost:3000
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/admin/studio   # 302 到登录
```

- [ ] **Step 4: Commit**

```bash
git add docs/studio.md
git commit -m "docs(studio): operator notes for the content workbench"
```

---

## 自检记录

- **Spec 覆盖**：PRD P0-06（创建任务）→ Task 3/7/9；P0-07（事实素材与引用）→ Task 3 快照/失效 + Task 10 事实卡展示；P0-08（生成草稿）→ Task 4/5；P0-09（审核/版本/审计）→ Task 6；P0-10（导出）→ Task 6/10；§17 全部落点约束已嵌入对应任务。行业适配（P0-01..P0-05）需 PRD §16 用户决策，不在本计划。
- **已知简化**：`facts` 无独立「权益」列，导出包 `benefit` 暂用事实标题占位（Task 6 说明）；`/admin/studio/new` 并入列表页内联表单；测试拆为 `tests/studio.test.ts` / `tests/studio-jobs.test.ts` / `tests/studio-export.test.ts` 三个自包含文件以支持并行执行。
- **类型一致**：`StudioTaskStatus`/`StudioDraftStatus`/`StudioExportPackage` 全程引用 `@aihot/contracts/studio`，后端 SQL 列名与契约字段 camelCase 映射在各函数内显式完成。
