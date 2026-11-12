-- Documentos grandes (fragmentos) e armazenamento opcional em R2
ALTER TABLE documents ADD COLUMN storage TEXT NOT NULL DEFAULT 'd1';
ALTER TABLE documents ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
CREATE TABLE document_chunks (
  doc_id TEXT NOT NULL, idx INTEGER NOT NULL, data_b64 TEXT NOT NULL, PRIMARY KEY (doc_id, idx)
);

-- Caixa de saída: e-mail, WhatsApp e webhooks. 'sent' somente quando o provedor confirma (2xx).
CREATE TABLE outbound_messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, channel TEXT NOT NULL, to_addr TEXT, subject TEXT, body TEXT,
  payload TEXT, status TEXT NOT NULL DEFAULT 'queued', provider TEXT, provider_ref TEXT, error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, related_type TEXT, related_id TEXT, legal_basis TEXT,
  confirmed_by TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX idx_outbound_org ON outbound_messages(org_id, created_at);
CREATE INDEX idx_outbound_due ON outbound_messages(status, next_attempt_at);

-- Tokens de integração de entrada (PDV, balança, PMS, HIS) e feed de agenda (ICS). Só o hash é guardado.
CREATE TABLE integration_tokens (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, label TEXT,
  unit_id TEXT, user_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_by TEXT, last_used_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_itokens_org ON integration_tokens(org_id, kind);

CREATE TABLE scale_readings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, unit_id TEXT NOT NULL, device TEXT, kind TEXT NOT NULL, food_id TEXT,
  lot_code TEXT, weight_g REAL NOT NULL, tare_g REAL NOT NULL DEFAULT 0, net_g REAL NOT NULL, recorded_at TEXT NOT NULL,
  waste_record_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX idx_scale_org ON scale_readings(org_id, unit_id, recorded_at);

-- LGPD: solicitações de titulares e anonimização
CREATE TABLE lgpd_requests (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'done', note TEXT, requested_by TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_lgpd_org ON lgpd_requests(org_id, created_at);
ALTER TABLE patients ADD COLUMN anonymized_at TEXT;
ALTER TABLE athletes ADD COLUMN anonymized_at TEXT;
