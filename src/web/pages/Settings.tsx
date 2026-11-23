import { useState } from 'react'
import { downloadCsv, get, post, put } from '../api'
import { Err, Page, useLoad, useMe } from '../ui'

export function Settings() {
  const { me, can, reload } = useMe()
  const [err, setErr] = useState<unknown>(null), [msg, setMsg] = useState(''), [mfa, setMfa] = useState<any>(null), [code, setCode] = useState('')
  const org = useLoad(() => get('/org'), [])
  const users = useLoad(() => (can('users.manage') ? get('/users') : Promise.resolve({ items: [] })), [])
  const audit = useLoad(() => (can('audit.read') ? get('/audit?limit=30') : Promise.resolve({ items: [] })), [])
  const run = async (fn: () => Promise<any>, ok: string) => { setErr(null); setMsg(''); try { await fn(); setMsg(ok); org.reload(); reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Configurações">
      <Err e={err} />{msg && <div className="okmsg">{msg}</div>}
      <div className="card"><h2 style={{ marginTop: 0 }}>Minha conta — autenticação em dois fatores</h2>
        {me.user.mfa_enabled ? <button className="bad" onClick={() => { const pw = prompt('Sua senha:'); const c = prompt('Código atual do app autenticador:'); if (pw && c) run(() => post('/auth/mfa/disable', { password: pw, code: c }), 'MFA desativado') }}>Desativar MFA</button>
          : mfa ? <div><p>Cadastre este segredo no app autenticador: <code>{mfa.secret}</code></p><div className="row"><input style={{ width: 140 }} placeholder="Código" value={code} onChange={(e) => setCode(e.target.value)} /><button onClick={() => run(() => post('/auth/mfa/enable', { code }), 'MFA ativado')}>Confirmar</button></div></div>
            : <button onClick={async () => { try { setMfa(await post('/auth/mfa/setup')) } catch (x) { setErr(x) } }}>Ativar MFA (TOTP)</button>}</div>
      {can('org.manage') && org.data && <div className="card"><h2 style={{ marginTop: 0 }}>Organização — {org.data.name} (plano {org.data.plan})</h2>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={org.data.ai_enabled} onChange={(e) => run(() => put('/org', { ai_enabled: e.target.checked }), 'Salvo')} /> IA assistiva (sugestões determinísticas com validação humana; nenhum dado sai da plataforma)</label>
        <label><input type="checkbox" style={{ width: 'auto' }} checked={org.data.require_mfa} onChange={(e) => run(() => put('/org', { require_mfa: e.target.checked }), 'Salvo')} /> Exigir MFA de todos os usuários</label>
        <p className="muted">Módulos: {org.data.modules?.join(', ')} • Limites: {JSON.stringify(org.data.limits)} • Cobrança: não configurada nesta versão.</p></div>}
      {can('users.manage') && <div className="card"><h2 style={{ marginTop: 0 }}>Usuários e papéis</h2><div className="tw"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papéis</th><th>MFA</th></tr></thead><tbody>{(users.data?.items ?? []).map((u: any) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.memberships.map((m: any) => m.role_name).join(', ')}</td><td>{u.mfa_enabled ? 'sim' : 'não'}</td></tr>)}</tbody></table></div></div>}
      {can('audit.read') && <div className="card"><div className="top"><h2 style={{ margin: 0 }}>Auditoria (últimos 30)</h2><button className="sec" onClick={() => downloadCsv('/audit?format=pdf&limit=500', 'auditoria.pdf').catch(setErr)}>PDF</button><button className="sec" onClick={() => downloadCsv('/audit?format=csv', 'auditoria.csv').catch(setErr)}>CSV</button></div>
        <div className="tw"><table><thead><tr><th>Quando</th><th>Ação</th><th>Entidade</th></tr></thead><tbody>{(audit.data?.items ?? []).map((a: any) => <tr key={a.id}><td>{String(a.ts).slice(0, 19).replace('T', ' ')}</td><td>{a.action}</td><td>{a.entity}</td></tr>)}</tbody></table></div></div>}
    </Page>
  )
}
