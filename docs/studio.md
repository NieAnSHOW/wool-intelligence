# 内容工作台（`/admin/studio`）

把站内已确认的资讯加工成可审核的自媒体素材：从文章或事实建任务 → Worker 付费生成平台草稿 → 人工审核 → 导出 JSON/Markdown 给外挂 Skill 或人工发布。核心系统不自动发布到任何平台。

- 事实卡是只读输入；任务创建时冻结 `facts.updated_at`，事实被合并或移动后详情页会提示「素材已变化」。
- 生成走 `studioDraft` 模型能力（`/admin/models` 可切换），提示词在 `industry/prompts/studio-draft.md`，版本随内容哈希变化并写入草稿。
- 导出即时生成不落盘；`studio_exports` 只记哈希与操作者。只有审核通过（`approved`，已导出的可换格式重取）的草稿可导出。
- 所有写操作有审计（`/admin/audit` 搜 `studio.`）。

**代码**：`packages/backend/src/admin/studio.ts`（任务/审核/导出）、`packages/backend/src/jobs/studio.ts`（生成）、`apps/web/app/routes/admin/studio*.tsx`（页面）。
