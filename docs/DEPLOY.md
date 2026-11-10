# Deploy na Cloudflare (gratuito, sem cartão)
1. Conta Cloudflare (plano Free). 2. Crie um **API token** com permissões *Workers Scripts: Edit* e *D1: Edit*; anote o *Account ID*.
3. No GitHub (Settings → Secrets → Actions): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. `git push` em `main`: o workflow roda testes, cria o D1 `nutrivida` (se faltar), aplica migrações, gera o segredo `DATA_KEY` na primeira vez e publica.
**Faça backup do `DATA_KEY`** (leia-o no momento da criação com `wrangler secret put` manual se preferir definir você mesmo): sem ele os campos cifrados não são recuperáveis.
Manual: `npx wrangler login && npx wrangler d1 create nutrivida` (copie o id para `wrangler.jsonc`) → `npm run db:migrate:remote` → `npx wrangler secret put DATA_KEY` → `npm run deploy`.
Primeiro acesso: abra a URL `*.workers.dev`, clique em *Criar conta*. Dados de demonstração: `npm run seed -- <url> <email> <senha>`.
Admin da plataforma: defina `PLATFORM_ADMIN_EMAIL` (var/secret) para habilitar `/api/admin/*` (planos e organizações).
Limites do plano Free (D1/Workers) podem exigir upgrade em produção real.
