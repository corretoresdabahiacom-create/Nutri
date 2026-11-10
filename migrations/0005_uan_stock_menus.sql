-- 0005 UAN, estoque, compras, produção, cardápios
CREATE TABLE menus (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'daily',
  diet_style TEXT NOT NULL DEFAULT 'any', excluded_food_ids TEXT NOT NULL DEFAULT '[]', excluded_tags TEXT NOT NULL DEFAULT '[]',
  date_from TEXT, date_to TEXT, status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, menu_key TEXT NOT NULL,
  is_template INTEGER NOT NULL DEFAULT 0, publish_at TEXT, valid_from TEXT, valid_until TEXT, public_token TEXT UNIQUE,
  budget_profile_id TEXT, approved_by TEXT, approved_at TEXT, published_by TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_menus_org ON menus(org_id, unit_id);
CREATE TABLE menu_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, menu_id TEXT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  date TEXT, meal_type TEXT NOT NULL DEFAULT 'almoco', section TEXT, recipe_id TEXT NOT NULL, diet_type_id TEXT,
  position INTEGER NOT NULL DEFAULT 0, planned_portions REAL, price REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_menu_items_menu ON menu_items(menu_id, date, meal_type, position);
CREATE TABLE contracts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, client_name TEXT NOT NULL, meal_price REAL,
  starts_on TEXT, ends_on TEXT, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE shifts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, name TEXT NOT NULL, starts TEXT, ends TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE equipment (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, name TEXT NOT NULL, capacity_portions_per_hour REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE food_points (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE meal_counts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, date TEXT NOT NULL, meal_type TEXT NOT NULL,
  shift_id TEXT, contract_id TEXT, planned REAL, served REAL, guests REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_meal_counts ON meal_counts(org_id, unit_id, date, meal_type);
CREATE TABLE stock_lots (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, food_id TEXT NOT NULL, lot_code TEXT NOT NULL,
  qty_g REAL NOT NULL, initial_qty_g REAL NOT NULL, expiry TEXT, supplier_id TEXT, unit_cost_per_kg REAL NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_lots ON stock_lots(org_id, unit_id, food_id, expiry);
CREATE TABLE stock_levels (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, food_id TEXT NOT NULL, min_g REAL, max_g REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, unit_id, food_id)
);
CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, food_id TEXT NOT NULL, lot_id TEXT, kind TEXT NOT NULL,
  qty_g REAL NOT NULL, unit_cost_per_kg REAL, reason TEXT, ref_type TEXT, ref_id TEXT, created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_movements ON stock_movements(org_id, unit_id, food_id, created_at);
CREATE TABLE purchase_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', notes TEXT,
  items TEXT NOT NULL DEFAULT '[]', requested_by TEXT, approved_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, supplier_id TEXT NOT NULL, request_id TEXT,
  status TEXT NOT NULL DEFAULT 'open', expected_on TEXT, created_by TEXT, received_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE purchase_order_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL, qty_g REAL NOT NULL, price_per_kg REAL NOT NULL, received_qty_g REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE production_orders (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, date TEXT NOT NULL, meal_type TEXT NOT NULL,
  menu_id TEXT, recipe_id TEXT NOT NULL, planned_portions REAL NOT NULL, produced_portions REAL, status TEXT NOT NULL DEFAULT 'planned',
  responsible_user_id TEXT, shift_id TEXT, contract_id TEXT, start_at TEXT, end_at TEXT, yield_g REAL, leftovers_g REAL, waste_g REAL,
  planned_cost REAL, actual_cost REAL, ingredient_snapshot TEXT NOT NULL DEFAULT '[]', stock_shortfalls TEXT NOT NULL DEFAULT '[]',
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_production ON production_orders(org_id, unit_id, date);
CREATE TABLE waste_records (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'desperdicio',
  food_id TEXT, recipe_id TEXT, qty_g REAL NOT NULL, cost REAL, reason TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_waste ON waste_records(org_id, unit_id, date);
CREATE TABLE sales (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, date TEXT NOT NULL, recipe_id TEXT NOT NULL,
  qty REAL NOT NULL, revenue REAL NOT NULL, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_sales ON sales(org_id, unit_id, date);
