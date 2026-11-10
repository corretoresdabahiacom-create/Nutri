# Estado do projeto
## Concluído (com testes automatizados)
Multi-tenant/multi-unidade, RBAC, MFA, cifra de campos, auditoria, planos configuráveis; alimentos/preços com fonte; fichas técnicas (custo, nutrição, versões, aprovação); perfis de orçamento; esportivo (atletas, avaliações e comparação, metas, suplementos + regras antidopagem, planos alimentares com checagem de alergia, diário, painel); hospitalar (leitos, pacientes, prescrições versionadas, motor de conflitos, conferência/liberação/produção/entrega, etiquetas, mapas, ocorrências, painel); UAN (FEFO, entradas/saídas/ajustes/transferências, compras com recebimento, produção com custo real, desperdício, dimensionamento parametrizado, previsão estatística, KPIs); cardápios (editor com arrastar-e-soltar, aprovação, publicação com link público e agendamento, versões, duplicação, CSV); restaurante (vendas, margem, planejado × real); hotel/resort (ocupação, banquetes, restrições com consentimento, link do hóspede, demanda); consolidação multiunidade; qualidade (checklists, temperatura, recebimento, NC e ações corretivas); agenda com lembretes; IA assistiva determinística; portal do paciente/atleta; exportações CSV auditadas; dados de demonstração fictícios; Docker; CI/CD.
## Parcial
- Planos alimentares: criação/edição via API; a interface só lista e aprova/revisa (sem editor de itens).
- Interface de checklists, ordens de compra, transferências de estoque e gestão de papéis/convites: apenas API.
- PDF: impressão do navegador (não gera arquivo no servidor). Documentos: base64 em D1 (≤ ~1 MB), sem R2.
- Importação CSV de alimentos/preços: via API.
## Pendente
Deploy efetivo na Cloudflare (workflow pronto; faltam credenciais), integrações (ver INTEGRATIONS), gráficos avançados, acessibilidade formal, testes de carga, teste de restauração de backup, PWA offline de dados (de propósito: nada clínico é cacheado).
## Limitações conhecidas
- Sem LLM; "IA" é regra + estatística simples. Previsões recusam histórico insuficiente.
- Sem base nutricional embutida (TACO/USDA etc.): o cliente importa a sua com fonte e licença; a demo usa valores ilustrativos rotulados como fictícios.
- Limites de CPU/tamanho do plano Free do Cloudflare; PBKDF2 100k.
- A auto-aprovação de requisições de compra exige flag explícita `allow_self` (organizações de 1 pessoa).
