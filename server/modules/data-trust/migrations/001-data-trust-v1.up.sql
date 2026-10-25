-- 钱多多财富数据可信度迁移 v1
-- 迁移 ID: 2026-10-23-data-trust-v1
-- 状态: 已授权实施；2026-10-23 冻结用于生产迁移
--
-- 重要说明:
-- 1. 本文件只包含追加式 schema 和必要索引，不包含业务数据回填。
-- 2. 数据回填必须由迁移 runner 在同一事务中调用经过测试的 Node/SQLite 实现完成。
-- 3. 禁止由普通应用启动流程自动执行本文件。
-- 4. 执行前必须停止生产服务、制作并验证一致性备份、在真实库副本上完整演练。

PRAGMA foreign_keys = ON;

-- 迁移状态表。runner 在执行前写入 running，成功后写入 completed，
-- 主迁移事务回滚后由 runner 在独立事务中写入 failed。
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  script_sha256 TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);

-- 原始证据资产。文件内容不可原地替换。
CREATE TABLE IF NOT EXISTS evidence_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_type TEXT NOT NULL CHECK (
    evidence_type IN (
      'income-screenshot',
      'trade-screenshot',
      'bank-statement',
      'product-document',
      'user-attestation',
      'other'
    )
  ),
  source_channel TEXT NOT NULL DEFAULT 'web-upload',
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  original_name TEXT NOT NULL DEFAULT '',
  storage_namespace TEXT NOT NULL DEFAULT '',
  storage_name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  captured_at TEXT,
  received_at TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'quarantined', 'deleted')
  ),
  status_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (evidence_type, sha256)
);

CREATE INDEX IF NOT EXISTS idx_evidence_assets_type_received
  ON evidence_assets(evidence_type, received_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_evidence_assets_storage
  ON evidence_assets(storage_namespace, storage_name);

CREATE INDEX IF NOT EXISTS idx_evidence_assets_available
  ON evidence_assets(available, status, received_at DESC);

-- 证据解析、人工校正和流程转换事件。只追加。
CREATE TABLE IF NOT EXISTS evidence_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id INTEGER NOT NULL
    REFERENCES evidence_assets(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'received',
      'duplicate_received',
      'ocr_completed',
      'machine_parsed',
      'vision_parsed',
      'human_corrected',
      'version_selected',
      'state_changed',
      'conflict_detected',
      'posted',
      'ignored',
      'failed',
      'reopened',
      'legacy_snapshot'
    )
  ),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('human', 'ocr', 'vision-model', 'automation', 'migration', 'system')
  ),
  actor_ref TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  confidence REAL CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 100)
  ),
  dedupe_key TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  previous_event_id INTEGER
    REFERENCES evidence_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_events_evidence
  ON evidence_events(evidence_id, created_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_evidence_events_type
  ON evidence_events(evidence_id, event_type, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_events_dedupe
  ON evidence_events(evidence_id, dedupe_key)
  WHERE dedupe_key <> '';

-- 跨域事实修订索引。当前值仍保存在各域权威表。
CREATE TABLE IF NOT EXISTS fact_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_type TEXT NOT NULL CHECK (length(fact_type) > 0),
  fact_key TEXT NOT NULL CHECK (length(fact_key) > 0),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  action TEXT NOT NULL CHECK (
    action IN ('create', 'update', 'delete', 'confirm', 'cancel', 'recalculate')
  ),
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  changed_fields_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  source_class TEXT NOT NULL CHECK (
    source_class IN (
      'bank-disclosure',
      'screenshot',
      'document',
      'manual',
      'derived',
      'automation',
      'migration'
    )
  ),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('human', 'ocr', 'vision-model', 'automation', 'migration', 'system')
  ),
  actor_ref TEXT NOT NULL DEFAULT '',
  operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
  request_id TEXT NOT NULL DEFAULT '',
  related_fact_type TEXT NOT NULL DEFAULT '',
  related_fact_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (fact_type, fact_key, revision_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_fact_revisions_operation
  ON fact_revisions(fact_type, fact_key, operation_id);

CREATE INDEX IF NOT EXISTS idx_fact_revisions_fact
  ON fact_revisions(fact_type, fact_key, revision_no DESC);

CREATE INDEX IF NOT EXISTS idx_fact_revisions_created
  ON fact_revisions(created_at DESC, id DESC);

-- 正式事实与证据解释版本的关联。一张截图支持多个事实，一个事实也可有多个证据。
CREATE TABLE IF NOT EXISTS fact_evidence_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_type TEXT NOT NULL CHECK (length(fact_type) > 0),
  fact_key TEXT NOT NULL CHECK (length(fact_key) > 0),
  fact_revision_id INTEGER NOT NULL
    REFERENCES fact_revisions(id) ON DELETE RESTRICT,
  evidence_id INTEGER NOT NULL
    REFERENCES evidence_assets(id) ON DELETE RESTRICT,
  evidence_event_id INTEGER NOT NULL
    REFERENCES evidence_events(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (
    role IN ('primary', 'corroborating', 'superseded', 'derived-input')
  ),
  field_paths_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 100)
  ),
  link_status TEXT NOT NULL DEFAULT 'active' CHECK (
    link_status IN ('active', 'superseded', 'rejected')
  ),
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retire_reason TEXT NOT NULL DEFAULT '',
  UNIQUE (
    fact_revision_id,
    evidence_id,
    evidence_event_id,
    role
  )
);

CREATE INDEX IF NOT EXISTS idx_fact_evidence_fact
  ON fact_evidence_links(fact_type, fact_key, link_status, id DESC);

CREATE INDEX IF NOT EXISTS idx_fact_evidence_evidence
  ON fact_evidence_links(evidence_id, link_status, id DESC);

CREATE INDEX IF NOT EXISTS idx_fact_evidence_event
  ON fact_evidence_links(evidence_event_id, id DESC);

-- 收益截图流程状态。status 保留为旧客户端兼容投影。
ALTER TABLE income_inbox
  ADD COLUMN evidence_id INTEGER
  REFERENCES evidence_assets(id) ON DELETE RESTRICT;

ALTER TABLE income_inbox
  ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'needs_correction'
  CHECK (
    workflow_state IN (
      'received',
      'needs_correction',
      'ready_to_post',
      'posted',
      'conflict_pending',
      'duplicate_resolved',
      'ignored',
      'failed_retryable'
    )
  );

ALTER TABLE income_inbox
  ADD COLUMN selected_event_id INTEGER
  REFERENCES evidence_events(id) ON DELETE RESTRICT;

ALTER TABLE income_inbox
  ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
  CHECK (state_version >= 0);

ALTER TABLE income_inbox
  ADD COLUMN last_request_id TEXT NOT NULL DEFAULT '';

-- 交易截图采用同一状态模型。
ALTER TABLE trade_inbox
  ADD COLUMN evidence_id INTEGER
  REFERENCES evidence_assets(id) ON DELETE RESTRICT;

ALTER TABLE trade_inbox
  ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'needs_correction'
  CHECK (
    workflow_state IN (
      'received',
      'needs_correction',
      'ready_to_post',
      'posted',
      'conflict_pending',
      'duplicate_resolved',
      'ignored',
      'failed_retryable'
    )
  );

ALTER TABLE trade_inbox
  ADD COLUMN selected_event_id INTEGER
  REFERENCES evidence_events(id) ON DELETE RESTRICT;

ALTER TABLE trade_inbox
  ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0
  CHECK (state_version >= 0);

ALTER TABLE trade_inbox
  ADD COLUMN last_request_id TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_income_inbox_evidence
  ON income_inbox(evidence_id)
  WHERE evidence_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_inbox_evidence
  ON trade_inbox(evidence_id)
  WHERE evidence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_income_inbox_workflow
  ON income_inbox(workflow_state, received_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_trade_inbox_workflow
  ON trade_inbox(workflow_state, received_at ASC, id ASC);

CREATE INDEX IF NOT EXISTS idx_income_inbox_selected_event
  ON income_inbox(selected_event_id);

CREATE INDEX IF NOT EXISTS idx_trade_inbox_selected_event
  ON trade_inbox(selected_event_id);
