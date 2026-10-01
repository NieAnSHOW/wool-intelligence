import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import type { Route } from "./+types/studio-item";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, Input, Select, Time } from "../../features/admin/ui";
import { STUDIO_PLATFORMS, type StudioExportPackage } from "@aihot/contracts/studio";

interface Draft {
  id: string;
  platform: string;
  version: number;
  status: string;
  content: { titleCandidates: string[]; body: string; tags?: string[]; openQuestions?: string[]; risks?: string[] };
  model: string;
  prompt_version: string;
  created_at: string;
}
interface Fact { id: number; title: string; subject: string | null; conditions: string | null; updated_at: string }
interface Detail {
  task: { id: string; title: string; status: string; angle: string; audience: string; version: number };
  drafts: Draft[];
  staleFacts: number[];
  facts: Fact[];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<Detail>(request, `/api/admin/studio/tasks/${params.id}`);
}

export const meta: Route.MetaFunction = () => [{ title: `任务详情 · ${SITE.name} 后台` }];

const download = (name: string, text: string, type: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
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
