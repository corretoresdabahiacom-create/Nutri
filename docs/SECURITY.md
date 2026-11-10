# Relatório de segurança e LGPD (evidência = testes em `test/`)
| Controle | Implementação | Evidência |
|---|---|---|
| Isolamento entre organizações | `org_id` em toda consulta; 404 (não 403) para fora de escopo; validação de referências cruzadas; `requireUnit` | testes de isolamento em todos os módulos; **um furo real foi encontrado e corrigido durante os testes** (unidade de outra organização aceita por admin org-wide) |
| RBAC no backend | `need`/`can` por rota + escopo de unidade | core/hospital/uan/menus tests |
| Escalada de privilégio | Não concede permissões que o ator não tem; último administrador protegido | core.test |
| Senhas | PBKDF2-SHA256 100k it. (limite do Workers), política ≥10 caracteres | core.test |
| Bloqueio de conta | 5 falhas → 15 min | core.test |
| MFA | TOTP RFC 6238; exigência por organização | core.test |
| Cifra em repouso (campo) | AES-256-GCM + AAD, rotação com `DATA_KEY_PREVIOUS` | sports/hospital/menus tests verificam texto cifrado no banco |
| Limitação de taxa | Janela fixa em D1, configurável | core.test |
| CSRF | Verificação de Origin em sessões por cookie | core.test |
| Auditoria | Ações sensíveis e leituras clínicas, sem conteúdo clínico no log; exportações auditadas | sports/demo tests |
| LGPD | Consentimento obrigatório (hóspedes), link único com expiração, minimização no resumo da cozinha, portal só do próprio titular | menus/ops tests |
| Cabeçalhos | nosniff, no-referrer, X-Frame-Options, `Cache-Control: no-store` na API | — |
**Limitações:** PBKDF2 com 100k iterações (teto do runtime); sem WAF/antivírus de upload; sem pentest independente; chaves de cifra em segredo do Worker (sem KMS); backup/restore apoia-se no *Time Travel* do D1 e em `wrangler d1 export` — **não houve teste de restauração automatizado**.
