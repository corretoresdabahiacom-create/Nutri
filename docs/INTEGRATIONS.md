# Integrações
Nenhuma integração externa está implementada. A tabela `integrations` guarda apenas configuração; os endpoints retornam `implemented:false` / HTTP 501.
| Integração | Estado | Caminho previsto |
|---|---|---|
| E-mail/WhatsApp | não implementada (`send-email` → 501) | Worker + provedor (MailChannels/Resend/API oficial WhatsApp) |
| Google Agenda | não implementada | OAuth + sincronização de `events` |
| PDV | importação manual de vendas (JSON/CSV) em `/sales/import` | conector por API |
| PMS hoteleiro | ocupação manual (`/occupancy`) | conector |
| HIS/prontuário | cadastro manual de pacientes | HL7/FHIR |
| Cobrança | não configurada (`billing_status: not_configured`) | gateway à escolha |
| IA generativa | não utilizada | opcional e por organização, com anonimização |
