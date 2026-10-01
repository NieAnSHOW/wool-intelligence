import { SITE } from "@aihot/industry/site";
import { Link, useNavigate } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/studio";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Textarea, Time } from "../../features/admin/ui";

interface Row {
  id: string;
  title: string;
  status: string;
  angle: string;
  priority: string;
  version: number;
  drafts: number;
  updated_at: string;
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  return adminGet<{ rows: Row[] }>(request, `/api/admin/studio/tasks${status ? `?status=${encodeURIComponent(status)}` : ""}`);
}

export const meta: Route.MetaFunction = () => [{ title: `内容工作台 · ${SITE.name} 后台` }];

export default function Studio({ loaderData }: Route.ComponentProps) {
  const { rows } = loaderData;
  const navigate = useNavigate();
  const { run, busy } = useAdminAction();
  const [title, setTitle] = useState("");
  const [refs, setRefs] = useState("");

  const create = async () => {
    // 一行一个引用：fact:123 / article:<id> / story:12
    const sourceRefs = refs.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [kind, id] = l.split(":");
      return { kind, id };
    });
    const res = await run<{ id: string }>("POST", "/api/admin/studio/tasks", { title, sourceRefs }, { label: "create-task" });
    if (res?.id) navigate(`/admin/studio/${res.id}`);
  };

  return (
    <AdminPage title="内容工作台" subtitle="从精选文章或事实创建传播任务，生成草稿、人工审核后导出给外挂 Skill 或人工发布。">
      <Card title="新建任务" className="mb-5">
        <div className="flex max-w-2xl flex-col gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="内部任务名，如「X 平台每日免费额度 · 小红书」" aria-label="任务名" />
          <Textarea rows={3} value={refs} onChange={(e) => setRefs(e.target.value)} placeholder={"引用（每行一个）：\nfact:42\narticle:ck…"} aria-label="来源引用" />
          <Button tone="primary" onClick={create} disabled={busy || !title.trim() || !refs.trim()}>创建并打开</Button>
        </div>
      </Card>
      <Card pad={false} title="任务">
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/studio/${r.id}`)}
          empty="还没有任务。从「内容诊断」页找到精选文章或事实，回来建第一个任务。"
          columns={[
            {
              key: "t", label: "任务",
              render: (r) => (
                <div className="min-w-[260px]">
                  <Link to={`/admin/studio/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id} · v{r.version}</div>
                </div>
              ),
            },
            { key: "st", label: "状态", render: (r) => <Badge tone={r.status === "exported" ? "muted" : r.status === "needs_review" ? "warn" : "accent"}>{r.status}</Badge> },
            { key: "a", label: "角度", render: (r) => r.angle || "—" },
            { key: "d", label: "草稿", align: "right", render: (r) => r.drafts },
            { key: "u", label: "更新", render: (r) => <Time at={r.updated_at} /> },
          ]}
        />
      </Card>
      {!rows.length && <Empty>创建第一个任务开始。</Empty>}
    </AdminPage>
  );
}
