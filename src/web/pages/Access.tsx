import { useState } from 'react'
import { del, get, post, put } from '../api'
import { Err, Page, UnitSelect, useLoad } from '../ui'

export function Access() {
  const roles = useLoad(() => get('/roles'), []), perms = useLoad(() => get('/permissions'), []), users = useLoad(() => get('/users'), []), invs = useLoad(() => get('/invitations'), [])
  const [err, setErr] = useState<unknown>(null), [token, setToken] = useState('')
  const [role, setRole] = useState({ key: '', name: '', permissions: [] as string[] }), [inv, setInv] = useState({ email: '', role_id: '', unit_id: '' })
  const run = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); roles.reload(); users.reload(); invs.reload() } catch (x) { setErr(x) } }
  const groups: Record<string, string[]> = {}
  for (const p of perms.data?.permissions ?? []) (groups[p.split('.')[0]] ??= []).push(p)
  const toggle = (p: string) => setRole({ ...role, permissions: role.permissions.includes(p) ? role.permissions.filter((x) => x !== p) : [...role.permissions, p] })
  return (
    <Page title="Usuários, papéis e convites">
      <Err e={err ?? roles.error} />
      <div className="card"><h2 style={{ marginTop: 0 }}>Convidar usuário</h2>
        <div className="form"><div className="field"><label>E-mail</label><input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></div>
          <div className="field"><label>Papel</label><select value={inv.role_id} onChange={(e) => setInv({ ...inv, role_id: e.target.value })}><option value="">—</option>{(roles.data?.items ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          <div className="field"><label>Unidade (opcional)</label><UnitSelect value={inv.unit_id} onChange={(v) => setInv({ ...inv, unit_id: v })} allowEmpty /></div></div>
        <button disabled={!inv.email || !inv.role_id} onClick={() => run(async () => { const r = await post('/invitations', { email: inv.email, role_id: inv.role_id, unit_id: inv.unit_id || undefined }); setToken(r.token); setInv({ email: '', role_id: '', unit_id: '' }) })}>Gerar convite</button>
        {token && <div className="okmsg" style={{ marginTop: 8 }}>Token (exibido uma vez; entregue por canal seguro — o envio por e-mail não está configurado): <code>{token}</code></div>}
        <div className="tw" style={{ marginTop: 10 }}><table><thead><tr><th>E-mail</th><th>Expira</th><th></th></tr></thead><tbody>{(invs.data?.items ?? []).map((i: any) => <tr key={i.id}><td>{i.email}</td><td>{String(i.expires_at).slice(0, 10)}</td><td><button className="bad" onClick={() => run(() => del(`/invitations/${i.id}`))}>Revogar</button></td></tr>)}</tbody></table></div></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Usuários</h2><div className="tw"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papéis</th></tr></thead><tbody>{(users.data?.items ?? []).map((u: any) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
        <td>{u.memberships.map((m: any) => <div key={m.id}>{m.role_name}{m.unit_id ? ' (unidade)' : ''} <button className="sec" style={{ padding: '0 6px' }} onClick={() => run(() => put(`/memberships/${m.id}`, { active: !m.active }))}>{m.active ? 'desativar' : 'ativar'}</button></div>)}</td></tr>)}</tbody></table></div></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Novo papel personalizado</h2>
        <div className="form"><div className="field"><label>Chave (a-z0-9_)</label><input value={role.key} onChange={(e) => setRole({ ...role, key: e.target.value })} /></div><div className="field"><label>Nome</label><input value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} /></div></div>
        {Object.entries(groups).map(([g, ps]) => <details key={g}><summary>{g} ({ps.filter((p) => role.permissions.includes(p)).length}/{ps.length})</summary><div className="row">{ps.map((p) => <label key={p} style={{ color: 'inherit' }}><input type="checkbox" style={{ width: 'auto' }} checked={role.permissions.includes(p)} onChange={() => toggle(p)} /> {p}</label>)}</div></details>)}
        <p className="muted">Você só pode conceder permissões que você mesmo possui.</p>
        <button disabled={!role.key || !role.name} onClick={() => run(async () => { await post('/roles', role); setRole({ key: '', name: '', permissions: [] }) })}>Criar papel</button></div>
    </Page>
  )
}
