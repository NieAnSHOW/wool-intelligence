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

/** The stored row, before the timestamp is turned into the ISO string the prompt needs. */
type DraftFactRow = Omit<DraftFactInput, "verifiedAt"> & { verifiedAt: Date };

export async function generateStudioDraft(taskId: string, platform: string, actor: string) {
  const [task] = await sql<{ title: string; angle: string; audience: string; fact_snapshot: Array<{ factId: number }> }[]>`
    SELECT title, angle, audience, fact_snapshot FROM studio_tasks WHERE id = ${taskId}`;
  if (!task) throw new Error(`studio task ${taskId} not found`);
  const ids = task.fact_snapshot.map((s) => s.factId);
  const facts = ids.length
    ? await sql<DraftFactRow[]>`
        SELECT f.id AS "factId", f.title, f.subject AS provider, f.conditions, f.updated_at AS "verifiedAt",
               (SELECT a.url FROM fact_articles fa JOIN articles a ON a.id = fa.article_id WHERE fa.fact_id = f.id
                ORDER BY CASE fa.role WHEN 'primary' THEN 0 WHEN 'report' THEN 1 ELSE 2 END LIMIT 1) AS "sourceUrl"
        FROM facts f WHERE f.id IN ${sql(ids)}`
    : [];
  const input: DraftFactInput[] = facts.map((f) => ({
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
