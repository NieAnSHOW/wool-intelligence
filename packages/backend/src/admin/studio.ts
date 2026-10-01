// Studio workbench administration (PRD §7): content tasks cut from selected material. Facts are
// read-only inputs frozen at creation; drafts never write back to facts or publications.
import { z } from "zod";
import { sql } from "../db.ts";
import { newShortId, sha256, stableJson } from "../lib/ids.ts";
import { enqueue, QUEUES } from "../jobs/queue.ts";
import { audit } from "./auth.ts";
import { Conflict } from "./sources.ts";
import type { DraftOutput } from "../jobs/studio.ts";
import type { StudioExportPackage, StudioFactSnapshotEntry, StudioPlatform, StudioSourceRef } from "@aihot/contracts/studio";

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

const parseOr400 = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => {
  const r = schema.safeParse(input);
  if (!r.success) throw bad(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300));
  return r.data;
};

async function snapshotFacts(refs: StudioSourceRef[]): Promise<StudioFactSnapshotEntry[]> {
  const ids = refs.filter((r) => r.kind === "fact").map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return [];
  const rows = await sql<{ id: number; updated_at: Date }[]>`SELECT id, updated_at FROM facts WHERE id IN ${sql(ids)}`;
  return rows.map((r) => ({ factId: r.id, updatedAt: r.updated_at.toISOString() }));
}

export async function createStudioTask(input: unknown, actor: string) {
  const b = parseOr400(CreateTaskSchema, input);
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
  const p = parseOr400(TaskPatchSchema, input.patch);
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

const DraftContentSchema = z.object({
  titleCandidates: z.array(z.string()).min(1).max(5),
  body: z.string().min(1),
  tags: z.array(z.string()).max(10),
  openQuestions: z.array(z.string()),
  risks: z.array(z.string()),
});

/** A human edit overwrites the draft's content and always drops it back to needs_review. */
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

/** Exports are generated on the fly; the row keeps only the metadata (format, hash, who). */
export async function exportStudioPackage(taskId: string, input: { draftId: string; format: "json" | "markdown" }, actor: string) {
  const detail = await studioTaskDetail(taskId);
  if (!detail) return null;
  const draft = detail.drafts.find((d) => d.id === input.draftId);
  if (!draft) throw bad("draft not found on this task");
  // 已导出过的草稿可以重复导出（同一份内容换个格式）；从未审核通过的不能导出。
  if (draft.status !== "approved" && draft.status !== "exported") throw bad("只有审核通过（approved）的草稿可以导出");
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
  return input.format === "json" ? { format: "json" as const, payloadHash, json: pkg } : { format: "markdown" as const, payloadHash, markdown };
}
