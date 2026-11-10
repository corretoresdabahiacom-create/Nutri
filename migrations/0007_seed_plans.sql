-- 0007 planos comerciais padrão (configuração, não dados de demonstração). Sem preços: configure no painel administrativo.
INSERT INTO plans (id,key,name,modules,limits,active,created_at,updated_at) VALUES
('plan-individual','individual','Individual','["core","sports","portal"]','{"max_units":1,"max_users":2,"max_patients":100}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
('plan-profissional','profissional','Profissional','["core","sports","clinical","portal","ai"]','{"max_units":3,"max_users":15,"max_patients":1000}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
('plan-institucional','institucional','Institucional','["core","clinical","uan","quality","portal","ai"]','{"max_units":20,"max_users":200,"max_patients":5000}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
('plan-foodservice','foodservice','Foodservice','["core","restaurant","hotel","resort","uan","quality","portal","ai"]','{"max_units":50,"max_users":300,"max_patients":0}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
('plan-enterprise','enterprise','Enterprise','["core","sports","clinical","uan","restaurant","hotel","resort","quality","ai","portal"]','{"max_units":1000,"max_users":5000,"max_patients":100000}',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
