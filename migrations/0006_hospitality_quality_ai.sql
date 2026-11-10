-- 0006 hotelaria/resort, qualidade, IA assistiva, portal
CREATE TABLE occupancy_forecasts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, date TEXT NOT NULL, rooms_occupied INTEGER,
  adults INTEGER NOT NULL DEFAULT 0, children INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, unit_id, date)
);
CREATE TABLE catering_events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL, meal_type TEXT,
  guests INTEGER NOT NULL DEFAULT 0, budget REAL, menu_id TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_catering ON catering_events(org_id, unit_id, date);
CREATE TABLE guest_restrictions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, guest_ref TEXT NOT NULL, room TEXT, stay_from TEXT, stay_to TEXT,
  allergies TEXT, intolerances TEXT, preferences TEXT, cultural_religious TEXT, consent_given INTEGER NOT NULL DEFAULT 0, consent_at TEXT,
  source TEXT NOT NULL DEFAULT 'staff', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_guest_restr ON guest_restrictions(org_id, unit_id);
CREATE TABLE guest_links (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, guest_ref TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE checklist_templates (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'boas_praticas',
  items TEXT NOT NULL DEFAULT '[]', procedure_ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE checklist_runs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, template_id TEXT NOT NULL, performed_by TEXT, date TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '[]', score REAL, status TEXT NOT NULL DEFAULT 'done', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE temperature_logs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, equipment TEXT NOT NULL, reading_c REAL NOT NULL,
  limit_min_c REAL, limit_max_c REAL, ok INTEGER NOT NULL DEFAULT 1, nonconformity_id TEXT, recorded_by TEXT, recorded_at TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_temp_logs ON temperature_logs(org_id, unit_id, recorded_at);
CREATE TABLE receiving_records (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, supplier_id TEXT, product TEXT NOT NULL, lot_code TEXT,
  temperature_c REAL, expiry TEXT, accepted INTEGER NOT NULL DEFAULT 1, evidence_doc_id TEXT, notes TEXT, recorded_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE nonconformities (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, source TEXT NOT NULL DEFAULT 'manual',
  severity TEXT NOT NULL DEFAULT 'minor', status TEXT NOT NULL DEFAULT 'open', responsible_user_id TEXT, evidence_doc_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_nc ON nonconformities(org_id, unit_id, status);
CREATE TABLE corrective_actions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, nonconformity_id TEXT NOT NULL, description TEXT NOT NULL,
  owner_user_id TEXT, due_date TEXT, done_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ai_suggestions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, disclosure TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_by TEXT, reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai ON ai_suggestions(org_id, status);
