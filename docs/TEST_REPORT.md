# Relatório de testes (execução real)
`npm test` → **8 arquivos, 70 testes, todos aprovados**; `npm run typecheck` sem erros; `vite build` ok; `wrangler deploy --dry-run` ok.
| Arquivo | Cobre |
|---|---|
| core | cadastro, login, MFA, bloqueio, CSRF, RBAC, limites de plano, cifra, rate limit, convites |
| recipes | custo/nutrição exatos, aprovação imutável, versões, substituição, proveniência de importação |
| sports | cifra, isolamento, escopo por unidade, comparação de avaliações, metas, suplementos proibidos, plano alimentar com conflito de alergia |
| hospital | cifra, leitos, histórico de prescrição, **conflito crítico bloqueia conferência e liberação**, reavaliação na liberação, fluxo completo com permissões separadas, cozinha sem dados clínicos |
| uan | FEFO, vencidos, ajustes, transferências, ciclo compra→recebimento→produção→custo real, dimensionamento, previsão sem dados inventados |
| menus | fluxo de aprovação/publicação, link público sem custo, agendamento (job), DnD, margens, hotelaria/LGPD, consolidação |
| ops | qualidade (NC automática), agenda/lembretes, IA assistiva, portal |
| demo | semeadura fictícia + painéis + exportações |
Verificação manual: UI executada com `wrangler dev` + Chromium (login, painel, pedidos hospitalares exibindo conflito crítico, cardápios) sem erros de console.
**Não testado:** carga/desempenho, acessibilidade formal (WCAG), navegadores além do Chromium, restauração de backup, deploy real na Cloudflare (sem credenciais neste ambiente).
