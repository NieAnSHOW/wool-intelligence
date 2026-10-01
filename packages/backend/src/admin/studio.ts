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
