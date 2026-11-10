-- NutriVida Pro - 0001 núcleo comum: multiempresa, usuários, papéis, auditoria
CREATE TABLE plans (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  modules TEXT NOT NULL DEFAULT '[]', limits TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'generic',
  plan_id TEXT, ai_enabled INTEGER NOT NULL DEFAULT 0, require_mfa INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'not_configured', settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL,
  mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  is_platform_admin INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE units (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_unit_id TEXT, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'generic', active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_units_org ON units(org_id);
CREATE TABLE departments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, name TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_departments_org ON departments(org_id);
CREATE TABLE teams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, name TEXT NOT NULL, member_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_teams_org ON teams(org_id);
CREATE TABLE job_titles (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_job_titles_org ON job_titles(org_id);
CREATE TABLE roles (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]', is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, key)
);
CREATE TABLE memberships (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL,
  unit_id TEXT, job_title_id TEXT, department_id TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_memberships_user ON memberships(user_id);
CREATE INDEX idx_memberships_org ON memberships(org_id);
CREATE TABLE professionals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL, council TEXT, council_number TEXT,
  specialty TEXT, display_name TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_professionals_org ON professionals(org_id);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL, role_id TEXT NOT NULL, unit_id TEXT,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT, expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, org_id TEXT, user_id TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}', ip TEXT, ts TEXT NOT NULL
);
CREATE INDEX idx_audit_org_ts ON audit_log(org_id, ts);
CREATE INDEX idx_audit_entity ON audit_log(org_id, entity, entity_id);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT, title TEXT NOT NULL, body TEXT,
  kind TEXT NOT NULL DEFAULT 'info', ref_type TEXT, ref_id TEXT, read_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_notifications_org ON notifications(org_id, user_id);
CREATE TABLE documents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, kind TEXT NOT NULL DEFAULT 'file',
  title TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, content_b64 TEXT NOT NULL,
  related_type TEXT, related_id TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_documents_org ON documents(org_id);
CREATE TABLE integrations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'not_configured',
  config_enc TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, kind)
);
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, org_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status);
