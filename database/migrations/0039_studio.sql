-- Studio workbench (PRD §7): admin-side content tasks cut from selected material, their platform
-- drafts and export records. Facts/articles/stories are read-only inputs; drafts never write back.
CREATE TABLE studio_tasks (
  id               text PRIMARY KEY,
  title            text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  angle            text NOT NULL DEFAULT '',
  audience         text NOT NULL DEFAULT '',
  target_platforms jsonb NOT NULL DEFAULT '[]',
  source_refs      jsonb NOT NULL DEFAULT '[]',
  fact_snapshot    jsonb NOT NULL DEFAULT '[]',
  priority         text NOT NULL DEFAULT 'normal',
  version          integer NOT NULL DEFAULT 1,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  archived_at      timestamptz
);

CREATE INDEX studio_tasks_status_idx ON studio_tasks (status, updated_at DESC);

CREATE TABLE studio_drafts (
  id             text PRIMARY KEY,
  task_id        text NOT NULL REFERENCES studio_tasks (id) ON DELETE CASCADE,
  platform       text NOT NULL,
  version        integer NOT NULL,
  status         text NOT NULL DEFAULT 'generated',
  content        jsonb NOT NULL,
  citations      jsonb NOT NULL DEFAULT '[]',
  model          text NOT NULL,
  prompt_version text NOT NULL,
  input_snapshot jsonb,
  review_reason  text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, platform, version)
);

CREATE INDEX studio_drafts_task_idx ON studio_drafts (task_id, created_at DESC);

CREATE TABLE studio_exports (
  id           text PRIMARY KEY,
  task_id      text NOT NULL REFERENCES studio_tasks (id) ON DELETE CASCADE,
  draft_id     text NOT NULL REFERENCES studio_drafts (id) ON DELETE CASCADE,
  format       text NOT NULL,
  payload_hash text NOT NULL,
  exported_by  text NOT NULL,
  exported_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX studio_exports_task_idx ON studio_exports (task_id, exported_at DESC);
