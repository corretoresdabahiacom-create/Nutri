# NutriVida Pro

SaaS multi-tenant de nutrição: **esportiva, hospitalar/clínica, UAN industrial, restaurantes, hotéis e resorts**.
Monólito modular em **Cloudflare Workers + D1 (SQLite)** com SPA React — gratuito e sem cartão no plano Free da Cloudflare.

> Estado honesto: MVP funcional e testado (70 testes automatizados). Veja `docs/STATUS.md` para o que está
> pronto, parcial, pendente e as limitações conhecidas. Integrações externas (e-mail, WhatsApp, Google Agenda, PDV, PMS, HIS, cobrança) **não** estão implementadas.

## Rodar localmente
```bash
npm install
cp .env.example .dev.vars        # defina DATA_KEY (openssl rand -base64 32)
npm run db:migrate:local
npm run build && npm run dev     # http://localhost:8787
npm run seed -- http://localhost:8787 demo@exemplo.com 'Senha-demo-123'   # dados 100% fictícios
npm test                          # 70 testes (Workers runtime real via Miniflare)
```
Docker: `DATA_KEY=$(openssl rand -base64 32) docker compose up --build`.

## Deploy (Cloudflare, sem cartão)
Ver `docs/DEPLOY.md`. Resumo: crie um API token (Workers + D1 edit), configure os secrets `CLOUDFLARE_API_TOKEN` e
`CLOUDFLARE_ACCOUNT_ID` no GitHub; todo push em `main` roda testes → migrações D1 → `wrangler deploy` (`.github/workflows/ci-deploy.yml`).

## Documentação
`docs/ARCHITECTURE.md` · `docs/DATA_MODEL.md` · `docs/SECURITY.md` (relatório) · `docs/TEST_REPORT.md` · `docs/INTEGRATIONS.md` · `docs/STATUS.md` · `docs/COMPETITIVE_ANALYSIS.md` · `docs/DEPLOY.md`
