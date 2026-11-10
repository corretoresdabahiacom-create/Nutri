# Modelo de dados (74 tabelas, `migrations/`)
- **0001 núcleo:** plans, organizations, users, units, departments, teams, job_titles, roles, memberships, professionals, invitations, sessions, rate_limits, audit_log, notifications, documents, integrations, jobs.
- **0002 alimentos/receitas:** foods (`org_id` nulo = base global só leitura; `source` obrigatório), suppliers, food_prices (fonte obrigatória), recipes (versionadas, aprovação imutável), recipe_items, budget_profiles.
- **0003 esportivo/agenda:** athletes, assessments, training_sessions, competitions, goals, meal_plans(+items), substance_rules, supplements, events, food_diary.
- **0004 hospitalar:** sectors, wards, rooms, beds, patients, diet_types, diet_prescriptions, clinical_notes, exams, meal_orders(+events), occurrences.
- **0005 UAN/estoque/cardápios:** menus(+items), contracts, shifts, equipment, food_points, meal_counts, stock_lots/levels/movements, purchase_requests/orders/items, production_orders, waste_records, sales.
- **0006 hotelaria/qualidade/IA:** occupancy_forecasts, catering_events, guest_restrictions, guest_links, checklist_*, temperature_logs, receiving_records, nonconformities, corrective_actions, ai_suggestions.
- **0007:** semente dos 5 planos (individual, profissional, institucional, foodservice, enterprise — sem preços).

Campos cifrados (AES-256-GCM, AAD `tabela.campo.id`): clínicos de atletas e pacientes, notas clínicas, restrições de hóspedes, segredo TOTP.
