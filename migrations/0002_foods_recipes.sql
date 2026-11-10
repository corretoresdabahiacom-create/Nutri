-- 0002 alimentos, fornecedores, preços, receitas, orçamento
CREATE TABLE foods (
  id TEXT PRIMARY KEY, org_id TEXT, name TEXT NOT NULL, category TEXT, kind TEXT NOT NULL DEFAULT 'in_natura',
  description TEXT, unit TEXT NOT NULL DEFAULT 'g', gross_g REAL, net_g REAL,
  correction_factor REAL NOT NULL DEFAULT 1, cooking_factor REAL NOT NULL DEFAULT 1,
  energy_kcal REAL, protein_g REAL, carb_g REAL, fat_g REAL, fiber_g REAL, sodium_mg REAL,
  micros TEXT NOT NULL DEFAULT '{}', allergens TEXT NOT NULL DEFAULT '[]', restrictions TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, table_version TEXT, source_updated_at TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_foods_org ON foods(org_id);
CREATE INDEX idx_foods_name ON foods(name);
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, tax_id TEXT, contact TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_suppliers_org ON suppliers(org_id);
CREATE TABLE food_prices (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, food_id TEXT NOT NULL, supplier_id TEXT,
  price_per_kg REAL NOT NULL, source TEXT NOT NULL, valid_from TEXT NOT NULL, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_prices_food ON food_prices(org_id, food_id, valid_from);
CREATE TABLE recipes (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT, recipe_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', name TEXT NOT NULL, category TEXT, description TEXT, method TEXT,
  prep_minutes INTEGER, yield_g REAL NOT NULL DEFAULT 0, portions REAL NOT NULL DEFAULT 1, portion_g REAL,
  consistency TEXT NOT NULL DEFAULT 'normal', diet_tags TEXT NOT NULL DEFAULT '[]',
  equipment TEXT NOT NULL DEFAULT '[]', storage TEXT, shelf_life TEXT, photo_doc_id TEXT,
  sale_price REAL, owner_user_id TEXT, approved_by TEXT, approved_at TEXT,
  nutrition_reviewed INTEGER NOT NULL DEFAULT 0, allergens_reviewed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_recipes_org ON recipes(org_id, recipe_key);
CREATE TABLE recipe_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL, gross_g REAL, net_g REAL NOT NULL, correction_factor REAL, unit TEXT NOT NULL DEFAULT 'g',
  notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_recipe_items_recipe ON recipe_items(recipe_id);
CREATE TABLE budget_profiles (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  rules TEXT NOT NULL DEFAULT '{}', limit_per_patient REAL, limit_per_day REAL, limit_per_meal REAL,
  limit_per_portion REAL, limit_per_menu REAL, limit_per_guest REAL, limit_per_event REAL, limit_per_unit REAL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, key)
);
