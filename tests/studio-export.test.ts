// Studio export invariants (PRD §7): rejection blocks export, approval produces a stable package
// (hash over the payload, one row per export) and an edit always drops back to needs_review.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { createStudioTask, editStudioDraft, exportStudioPackage, reviewStudioDraft } from "@aihot/backend/admin/studio";
import { applyGeneration } from "@aihot/backend/jobs/studio";

const actor = "admin:1";
const newFact = async () => (await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`pub-${tag()}`}, ${`事实 ${tag()}`}) RETURNING id`)[0]!.id;

after(async () => {
  await closeDb();
});

/** A fact with a primary source article, so the export's sourceUrl/citations wiring is observable. */
const newFactWithArticle = async () => {
  const factId = await newFact();
  const sourceId = `src-${tag()}`;
  const sourceUrl = `https://example.com/studio-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, next_fetch_at) VALUES (${sourceId}, 'Test studio export', 'rss', '2100-01-01')`;
  const [article] = await sql<{ id: string }[]>`
    INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${`art-${tag()}`}, ${sourceId}, ${`ik-${tag()}`}, ${sourceUrl}, '来源文章', now(), now()) RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${factId}, ${article!.id}, 'primary')`;
  return { factId, sourceUrl };
};

test("review then export: rejected drafts cannot export, approved ones produce a stable package", async () => {
  const { factId, sourceUrl } = await newFactWithArticle();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const d1 = await applyGeneration(id, "topic", { titleCandidates: ["A"], body: "b", tags: [], openQuestions: [], risks: [] }, "default", "v", actor);
  await reviewStudioDraft(d1.id, { decision: "reject", reason: "语气太满" }, actor);
  await assert.rejects(exportStudioPackage(id, { draftId: d1.id, format: "json" }, actor), /approved/);

  const d2 = await applyGeneration(id, "topic", { titleCandidates: ["B"], body: "b2", tags: ["t"], openQuestions: ["q"], risks: ["r"] }, "default", "v", actor);
  await reviewStudioDraft(d2.id, { decision: "approve", reason: "核对无误" }, actor);
  const pkg = await exportStudioPackage(id, { draftId: d2.id, format: "json" }, actor);
  assert.ok(pkg && pkg.format === "json");
  assert.equal(pkg.json.schemaVersion, 1);
  assert.ok(pkg.json.facts.length >= 1);
  assert.ok(pkg.json.citations.length >= 1);
  assert.equal(pkg.json.facts[0]!.sourceUrl, sourceUrl);
  assert.deepEqual(pkg.json.citations, pkg.json.facts.map((f) => ({ factId: f.factId, articleUrl: f.sourceUrl, note: null })));
  const again = await exportStudioPackage(id, { draftId: d2.id, format: "markdown" }, actor);
  assert.ok(again && again.format === "markdown");
  assert.match(again.markdown, /事实卡/);
  const rows = await sql`SELECT count(*)::int AS n FROM studio_exports WHERE task_id = ${id}`;
  assert.equal(rows[0]!.n, 2);
});

test("editing a draft marks it needs_review", async () => {
  const factId = await newFact();
  const { id } = await createStudioTask({ title: `任务 ${tag()}`, sourceRefs: [{ kind: "fact", id: String(factId) }] }, actor);
  const d = await applyGeneration(id, "wechat", { titleCandidates: ["A"], body: "b", tags: [], openQuestions: [], risks: [] }, "default", "v", actor);
  const edited = await editStudioDraft(d.id, { content: { titleCandidates: ["A2"], body: "b", tags: [], openQuestions: [], risks: [] }, reason: "改标题" }, actor);
  assert.equal(edited!.status, "needs_review");
});
