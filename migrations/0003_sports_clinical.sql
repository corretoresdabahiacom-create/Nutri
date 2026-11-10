-- 0003 esportivo, pessoas atendidas, planos alimentares, agenda
CREATE TABLE athletes (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, user_id TEXT, name TEXT NOT NULL,
  birth_date TEXT, sex TEXT, height_cm REAL, weight_kg REAL, sport TEXT, category TEXT, position TEXT,
  training_freq_week INTEGER, training_minutes INTEGER, intensity TEXT, goals TEXT, sleep_hours REAL, hydration_ml REAL,
  clinical_history TEXT, medications TEXT, allergies TEXT, restrictions TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_athletes_org ON athletes(org_id);
CREATE TABLE assessments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, subject_type TEXT NOT NULL DEFAULT 'athlete', subject_id TEXT NOT NULL,
  date TEXT NOT NULL, weight_kg REAL, height_cm REAL, circumferences TEXT NOT NULL DEFAULT '{}', skinfolds TEXT NOT NULL DEFAULT '{}',
  body_fat_pct REAL, lean_mass_kg REAL, recovery_score REAL, fatigue_score REAL, performance TEXT NOT NULL DEFAULT '{}',
  notes TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_assessments_subject ON assessments(org_id, subject_type, subject_id, date);
CREATE TABLE training_sessions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, athlete_id TEXT NOT NULL, date TEXT NOT NULL,
  kind TEXT, duration_min INTEGER, rpe REAL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_training_athlete ON training_sessions(org_id, athlete_id, date);
CREATE TABLE competitions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, athlete_id TEXT NOT NULL, name TEXT NOT NULL, date TEXT NOT NULL,
  location TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_competitions_athlete ON competitions(org_id, athlete_id, date);
CREATE TABLE goals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, subject_type TEXT NOT NULL DEFAULT 'athlete', subject_id TEXT NOT NULL,
  metric TEXT NOT NULL, target REAL, current REAL, start_value REAL, due_date TEXT, status TEXT NOT NULL DEFAULT 'open', notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_goals_subject ON goals(org_id, subject_type, subject_id);
CREATE TABLE meal_plans (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, subject_type TEXT NOT NULL DEFAULT 'athlete', subject_id TEXT NOT NULL,
  name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', valid_from TEXT, valid_to TEXT,
  strategies TEXT NOT NULL DEFAULT '{}', periodization TEXT NOT NULL DEFAULT '[]', notes TEXT,
  created_by TEXT, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_plans_subject ON meal_plans(org_id, subject_type, subject_id);
CREATE TABLE meal_plan_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  meal_name TEXT NOT NULL, meal_time TEXT, food_id TEXT, recipe_id TEXT, qty_g REAL NOT NULL DEFAULT 0, notes TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_plan_items_plan ON meal_plan_items(plan_id);
CREATE TABLE substance_rules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, sport TEXT, severity TEXT NOT NULL DEFAULT 'warning',
  source TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_substance_rules_org ON substance_rules(org_id);
CREATE TABLE supplements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, subject_type TEXT NOT NULL DEFAULT 'athlete', subject_id TEXT NOT NULL,
  product TEXT NOT NULL, ingredient TEXT NOT NULL, dose TEXT NOT NULL, dose_time TEXT, objective TEXT, start_date TEXT, end_date TEXT,
  notes TEXT, warnings TEXT NOT NULL DEFAULT '[]', override_reason TEXT, prescribed_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_supplements_subject ON supplements(org_id, subject_type, subject_id);
CREATE TABLE events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, kind TEXT NOT NULL DEFAULT 'consulta', title TEXT NOT NULL,
  starts_at TEXT NOT NULL, ends_at TEXT, owner_user_id TEXT, participants TEXT NOT NULL DEFAULT '[]', reminder_minutes INTEGER,
  status TEXT NOT NULL DEFAULT 'scheduled', related_type TEXT, related_id TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_events_org ON events(org_id, starts_at);
CREATE TABLE food_diary (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, date TEXT NOT NULL,
  meal_name TEXT NOT NULL, description TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_diary_subject ON food_diary(org_id, subject_type, subject_id, date);
