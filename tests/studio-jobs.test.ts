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
