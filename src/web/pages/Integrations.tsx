import { useState } from 'react'
import { del, get, post, put } from '../api'
import { Badge, Err, Page, UnitSelect, useLoad } from '../ui'

const LABEL: Record<string, string> = { email: 'E-mail (Resend)', whatsapp_business: 'WhatsApp Business (API oficial)', erp_webhook: 'Webhook para ERP (assinado HMAC)', pdv: 'PDV (entrada)', scale: 'Balança (entrada)', hotel_pms: 'PMS hoteleiro (entrada)', hospital_his: 'Prontuário/HIS FHIR (entrada)', calendar_ics: 'Agenda (feed ICS)', google_calendar: 'Google Agenda (OAuth)', billing: 'Cobrança recorrente' }
const FIELD: Record<string, string> = { api_key: 'Chave da API', from: 'Remetente (ex.: Nome <no-reply@dominio>)', token: 'Token de acesso', phone_id: 'ID do número (phone_id)', url: 'URL https do webhook', secret: 'Segredo de assinatura' }
const SECRET = ['api_key', 'token', 'secret']

export function Integrations() {
  const list = useLoad(() => get('/integrations'), []), toks = useLoad(() => get('/integration-tokens'), []), box = useLoad(() => get('/outbox'), [])
  const [err, setErr] = useState<unknown>(null), [msg, setMsg] = useState(''), [cfg, setCfg] = useState<Record<string, Record<string, string>>>({}), [to, setTo] = useState('')
  const [nt, setNt] = useState({ kind: 'pdv', unit_id: '', label: '' }), [shown, setShown] = useState(''), [feed, setFeed] = useState('')
  const run = async (fn: () => Promise<any>, ok = '') => { setErr(null); setMsg(''); try { const r = await fn(); setMsg(ok); list.reload(); toks.reload(); box.reload(); return r } catch (x) { setErr(x) } }
  return (
    <Page title="Integrações">
      <Err e={err ?? list.error} />{msg && <div className="okmsg">{msg}</div>}
      <p className="muted">Nada é simulado: um envio só aparece como concluído quando o provedor confirma. Credenciais ficam cifradas e não são exibidas novamente.</p>
      {(list.data?.items ?? []).map((i: any) => <div key={i.kind} className="card">
        <div className="top"><h3 style={{ margin: 0 }}>{LABEL[i.kind] ?? i.kind}</h3><Badge v={i.implemented ? (i.status === 'verified' || i.status === 'active' ? 'ok' : 'warning') : 'critical'} text={i.implemented ? i.status : 'não implementada'} /></div>
        {i.note && <p className="muted">{i.note}</p>}
        {i.fields && <><div className="form">{i.fields.map((k: string) => <div className="field" key={k}><label>{FIELD[k] ?? k}</label><input type={SECRET.includes(k) ? 'password' : 'text'} autoComplete="off" value={cfg[i.kind]?.[k] ?? ''} onChange={(e) => setCfg({ ...cfg, [i.kind]: { ...cfg[i.kind], [k]: e.target.value } })} /></div>)}</div>
          <div className="row"><button onClick={() => run(() => put(`/integrations/${i.kind}`, { config: cfg[i.kind] ?? {} }), 'Configuração salva (cifrada).')}>Salvar</button>
            {i.kind !== 'erp_webhook' && <input style={{ maxWidth: 220 }} placeholder={i.kind === 'email' ? 'e-mail de teste' : 'telefone com DDI'} value={to} onChange={(e) => setTo(e.target.value)} />}
            <button className="sec" onClick={() => run(() => post(`/integrations/${i.kind}/test`, { to }), 'Teste confirmado pelo provedor.')}>Testar</button>
            <button className="bad" onClick={() => confirm('Remover credenciais?') && run(() => del(`/integrations/${i.kind}`), 'Removida.')}>Remover</button></div></>}
        {i.mode === 'entrada' && <p className="muted">Gere um token abaixo e configure o equipamento/sistema para enviar para <code>/api/inbound/{({ pdv: 'pdv', scale: 'scale', hotel_pms: 'pms', hospital_his: 'his/fhir' } as any)[i.kind]}</code> com <code>Authorization: Bearer &lt;token&gt;</code>. Tokens ativos: {i.active_tokens}.</p>}
        {i.kind === 'calendar_ics' && <div className="row"><button onClick={async () => { const r = await run(() => post('/calendar-feed', {})); if (r) setFeed(location.origin + r.url_path) }}>Gerar meu link de agenda</button>{feed && <code style={{ wordBreak: 'break-all' }}>{feed}</code>}</div>}
      </div>)}
      <div className="card"><h2 style={{ marginTop: 0 }}>Tokens de integração de entrada</h2>
        <div className="row"><select value={nt.kind} onChange={(e) => setNt({ ...nt, kind: e.target.value })}>{['pdv', 'scale', 'hotel_pms', 'hospital_his'].map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}</select>
          <div style={{ minWidth: 200 }}><UnitSelect value={nt.unit_id} onChange={(v) => setNt({ ...nt, unit_id: v })} allowEmpty /></div><input style={{ maxWidth: 200 }} placeholder="Rótulo" value={nt.label} onChange={(e) => setNt({ ...nt, label: e.target.value })} />
          <button onClick={async () => { const r = await run(() => post('/integration-tokens', { kind: nt.kind, unit_id: nt.unit_id || undefined, label: nt.label || undefined })); if (r) setShown(r.token) }}>Gerar token</button></div>
        {shown && <div className="okmsg" style={{ marginTop: 8 }}>Token (exibido uma única vez): <code>{shown}</code></div>}
        <div className="tw"><table><thead><tr><th>Tipo</th><th>Rótulo</th><th>Último uso</th><th>Ativo</th><th></th></tr></thead><tbody>{(toks.data?.items ?? []).map((t: any) => <tr key={t.id}><td>{LABEL[t.kind]}</td><td>{t.label}</td><td>{t.last_used_at ? String(t.last_used_at).slice(0, 16) : 'nunca'}</td><td>{t.active ? 'sim' : 'revogado'}</td><td>{t.active ? <button className="bad" onClick={() => run(() => del(`/integration-tokens/${t.id}`), 'Revogado.')}>Revogar</button> : null}</td></tr>)}</tbody></table></div></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Caixa de saída</h2><div className="tw"><table><thead><tr><th>Quando</th><th>Canal</th><th>Destino/evento</th><th>Status</th><th>Erro</th><th></th></tr></thead><tbody>{(box.data?.items ?? []).map((m: any) => <tr key={m.id}><td>{String(m.created_at).slice(0, 16).replace('T', ' ')}</td><td>{m.channel}</td><td>{m.to_addr ?? m.subject}</td><td><Badge v={m.status === 'sent' ? 'ok' : m.status === 'failed' ? 'critical' : 'warning'} text={`${m.status} (${m.attempts})`} /></td><td>{m.error ?? ''}</td>
        <td>{m.status !== 'sent' && <button className="sec" onClick={() => run(() => post(`/outbox/${m.id}/retry`, {}), 'Reenvio tentado.')}>Reenviar</button>}</td></tr>)}</tbody></table></div></div>
    </Page>
  )
}
