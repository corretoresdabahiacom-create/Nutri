-- 0004 clínico/hospitalar
CREATE TABLE sectors (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE wards (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, sector_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE rooms (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, ward_id TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE beds (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, sector_id TEXT, ward_id TEXT, room_id TEXT,
  code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'free', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, unit_id, code)
);
CREATE INDEX idx_beds_org ON beds(org_id, unit_id);
CREATE TABLE patients (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, user_id TEXT, internal_code TEXT NOT NULL, name TEXT NOT NULL,
  birth_date TEXT, sex TEXT, admission_date TEXT, discharge_date TEXT, status TEXT NOT NULL DEFAULT 'admitted', bed_id TEXT,
  clinical_responsible_user_id TEXT, diagnoses TEXT, allergies TEXT, intolerances TEXT, restrictions TEXT,
  dysphagia INTEGER NOT NULL DEFAULT 0, consistency TEXT NOT NULL DEFAULT 'normal', feeding_route TEXT NOT NULL DEFAULT 'oral',
  nutritional_needs TEXT, nutritional_risk TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, internal_code)
);
CREATE INDEX idx_patients_org ON patients(org_id, unit_id, status);
CREATE TABLE diet_types (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  rules TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, key)
);
CREATE TABLE diet_prescriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, patient_id TEXT NOT NULL, diet_type_id TEXT NOT NULL,
  consistency TEXT NOT NULL DEFAULT 'normal', feeding_route TEXT NOT NULL DEFAULT 'oral',
  restrictions TEXT, supplementation TEXT, notes TEXT, valid_from TEXT NOT NULL, valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active', prescribed_by TEXT NOT NULL, prescribed_at TEXT NOT NULL,
  change_reason TEXT, prev_prescription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_prescriptions_patient ON diet_prescriptions(org_id, patient_id, status);
CREATE TABLE clinical_notes (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, patient_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'evolucao',
  content TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_clinical_notes_patient ON clinical_notes(org_id, patient_id, created_at);
CREATE TABLE exams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, patient_id TEXT NOT NULL, date TEXT NOT NULL,
  name TEXT NOT NULL, value TEXT NOT NULL, unit TEXT, reference TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_exams_patient ON exams(org_id, patient_id, date);
CREATE TABLE meal_orders (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, patient_id TEXT NOT NULL, bed_id TEXT,
  date TEXT NOT NULL, meal_type TEXT NOT NULL, scheduled_time TEXT, recipe_id TEXT, prescription_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', conflicts TEXT NOT NULL DEFAULT '[]', conflict_level TEXT NOT NULL DEFAULT 'none',
  warnings_ack_by TEXT, warnings_ack_note TEXT, conferred_by TEXT, conferred_at TEXT, released_by TEXT, released_at TEXT,
  produced_by TEXT, produced_at TEXT, delivered_by TEXT, delivered_at TEXT, label_code TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, patient_id, date, meal_type)
);
CREATE INDEX idx_meal_orders_day ON meal_orders(org_id, unit_id, date, meal_type);
CREATE TABLE meal_order_events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, meal_order_id TEXT NOT NULL, action TEXT NOT NULL, user_id TEXT, note TEXT, ts TEXT NOT NULL
);
CREATE INDEX idx_meal_order_events ON meal_order_events(org_id, meal_order_id);
CREATE TABLE occurrences (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, meal_order_id TEXT, kind TEXT NOT NULL, description TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_occurrences_org ON occurrences(org_id, unit_id);
