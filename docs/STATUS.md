# Estado do projeto
## Concluído (com testes automatizados)
Multi-tenant/multi-unidade, RBAC, MFA, cifra de campos, auditoria, planos configuráveis; alimentos/preços com fonte; fichas técnicas (custo, nutrição, versões, aprovação); perfis de orçamento; esportivo (atletas, avaliações e comparação, metas, suplementos + regras antidopagem, planos alimentares com checagem de alergia, diário, painel); hospitalar (leitos, pacientes, prescrições versionadas, motor de conflitos, conferência/liberação/produção/entrega, etiquetas, mapas, ocorrências, painel); UAN (FEFO, entradas/saídas/ajustes/transferências, compras com recebimento, produção com custo real, desperdício, dimensionamento parametrizado, previsão estatística, KPIs); cardápios (editor com arrastar-e-soltar, aprovação, publicação com link público e agendamento, versões, duplicação, CSV); restaurante (vendas, margem, planejado × real); hotel/resort (ocupação, banquetes, restrições com consentimento, link do hóspede, demanda); consolidação multiunidade; qualidade (checklists, temperatura, recebimento, NC e ações corretivas); interface completa para editor de plano alimentar, checklists, compras/recebimento, transferências, papéis/convites e importação CSV; agenda com lembretes; IA assistiva determinística; portal do paciente/atleta; exportações CSV auditadas; dados de demonstração fictícios; Docker; CI/CD.
## Parcial
- Telas novas (editor de plano, checklists, compras, transferência, papéis/convites, importação CSV) validadas por typecheck, build e navegação em Chromium sem erros de console; não há testes E2E automatizados de UI (a lógica de backend é coberta pelos 70 testes).
- Convites: o token é exibido uma vez; não há envio por e-mail.
- PDF: impressão do navegador (não gera arquivo no servidor). Documentos: base64 em D1 (≤ ~1 MB), sem R2.
## Pendente
Deploy efetivo na Cloudflare (workflow pronto; faltam credenciais), integrações (ver INTEGRATIONS), gráficos avançados, acessibilidade formal, testes de carga, teste de restauração de backup, PWA offline de dados (de propósito: nada clínico é cacheado).
## Limitações conhecidas
- Sem LLM; "IA" é regra + estatística simples. Previsões recusam histórico insuficiente.
- Sem base nutricional embutida (TACO/USDA etc.): o cliente importa a sua com fonte e licença; a demo usa valores ilustrativos rotulados como fictícios.
- Limites de CPU/tamanho do plano Free do Cloudflare; PBKDF2 100k.
- A auto-aprovação de requisições de compra exige flag explícita `allow_self` (organizações de 1 pessoa).
