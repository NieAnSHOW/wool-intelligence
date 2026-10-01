// Studio workbench invariants (PRD §7/§9): a task freezes its facts' updatedAt; a stale version
// edit is rejected; merge-moved facts show up as drift. Model generation is covered elsewhere.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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

  const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${randomUUID()}, ${`故事 ${tag()}`}, now(), now()) RETURNING id`;
  await sql`UPDATE facts SET story_id = ${story!.id}, updated_at = now() WHERE id = ${factId}`;
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
