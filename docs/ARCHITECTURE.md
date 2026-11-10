# Arquitetura

**Monólito modular** em um único Worker (Hono). Frontend SPA (React 19 + Vite) servido pelos *Workers Static Assets*
(`/api/*` roda o Worker primeiro; demais rotas caem no SPA). Banco: **D1**. Cron `*/5 * * * *` executa `lib/jobs.ts`
(publicação agendada de cardápios, expiração, lembretes de agenda).

```
src/worker/
  index.ts            app Hono, headers de segurança, erros JSON, cron
  lib/  auth.ts rbac.ts crypto.ts crud.ts subject.ts calc.ts jobs.ts util.ts
  routes/ auth core foods recipes sports hospital uan menus ops exports
src/web/              SPA (páginas por módulo + CRUD genérico dirigido por configuração)
migrations/           0001..0007 (SQL puro)   test/  Vitest + @cloudflare/vitest-pool-workers
```
## Decisões
| Tema | Decisão | Motivo / desvio do briefing |
|---|---|---|
| Banco | D1 (SQLite) com SQL puro | Gratuito sem cartão. Desvio: briefing sugere PostgreSQL/ORM. |
| Arquivos | Documentos em base64 no D1 (≤ ~1 MB) | R2 exige cartão. Evolução: trocar por R2. |
| Multi-tenant | `org_id` em toda linha; toda consulta filtra pela organização da sessão | Isolamento testado. |
| Multi-unidade | Árvore de unidades; papéis com escopo de unidade (inclui descendentes) | `requireUnit` valida que a unidade pertence à organização. |
| RBAC | Catálogo de permissões + 18 papéis-modelo clonados por organização; vários papéis por usuário | Validado no backend em toda rota. |
| Planos | Tabela `plans` com módulos e limites (sem preços); limites aplicados no backend | Sem cobrança simulada. |
| Sessão | Token opaco (hash SHA-256 no banco), Bearer ou cookie HttpOnly | CSRF por checagem de Origin no cookie. |
| IA | "Assistente analítico" determinístico, sem LLM externo | Aceite humano obrigatório; liga/desliga por organização. |
| PDF | Impressão do navegador (CSS `@media print`) | Sem servidor de PDF no plano gratuito. |

## Fluxo hospitalar
Prescrição (histórico versionado) → geração de pedidos por unidade/dia → **motor de conflitos** (alergia, intolerância,
restrição, consistência/disfagia, via de alimentação, regras da dieta, alteração recente) → conferência
(`hospital.confer`) → liberação (`hospital.release`, **reavalia** e bloqueia crítico) → produção → entrega, com trilha de eventos.
Conflito crítico **não tem exceção**: resolve-se substituindo a preparação.
