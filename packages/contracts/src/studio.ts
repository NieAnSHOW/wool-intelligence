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
