// HTTP wiring of the studio routes: the guard without a session, create → detail round-trip with
// staleFacts, and the export gate for drafts that were never approved.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";
import { applyGeneration } from "@aihot/backend/jobs/studio";

const T = tag();
const app = await buildApp();
const csrf = { "x-csrf-token": "dev" };

after(async () => {
  config.devAdmin = null;
  await app.close();
  await closeDb();
});

const newFact = (label: string) =>
  sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`pub-${label}-${T}`}, ${`事实 ${label} ${T}`}) RETURNING id`;

const createTask = (factId: number, title: string) =>
  app.inject({
    method: "POST", url: "/api/admin/studio/tasks", headers: csrf,
    payload: { title, sourceRefs: [{ kind: "fact", id: String(factId) }] },
  });

test("without a session the studio API is closed", async () => {
  config.devAdmin = null;
  const res = await app.inject({ method: "GET", url: "/api/admin/studio/tasks" });
  assert.equal(res.statusCode, 401);
});

test("a dev session creates a task and the detail carries staleFacts", async () => {
  config.devAdmin = { displayName: T };
  const [fact] = await newFact("a");
  const created = await createTask(fact!.id, `任务 ${T}`);
  assert.equal(created.statusCode, 200, created.body);
  const { id } = created.json() as { id: string };
  const detail = await app.inject({ method: "GET", url: `/api/admin/studio/tasks/${id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  const body = detail.json() as { task: { id: string }; staleFacts: number[] };
  assert.equal(body.task.id, id);
  assert.deepEqual(body.staleFacts, []);
});

test("exporting a draft that was never approved is rejected", async () => {
  const [fact] = await newFact("b");
  const created = await createTask(fact!.id, `任务2 ${T}`);
  const { id } = created.json() as { id: string };
  const draft = await applyGeneration(id, "topic", { titleCandidates: ["A"], body: "b", tags: [], openQuestions: [], risks: [] }, "default", "v", `dev:${T}`);
  const res = await app.inject({
    method: "POST", url: `/api/admin/studio/tasks/${id}/export`, headers: csrf,
    payload: { draftId: draft.id, format: "json" },
  });
  assert.equal(res.statusCode, 400, res.body);
});
