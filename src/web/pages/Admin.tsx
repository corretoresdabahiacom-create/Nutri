import { useState } from 'react'
import { get, post, put } from '../api'
import { Err, Page, useLoad } from '../ui'

/** Painel da plataforma: planos configuráveis (módulos e limites) e plano de cada organização. Sem preços e sem cobrança. */
export function Admin() {
  const plans = useLoad(() => get('/admin/plans'), []), orgs = useLoad(() => get('/admin/organizations'), [])
  const [err, setErr] = useState<unknown>(null), [np, setNp] = useState({ key: '', name: '', modules: '', limits: '{}' })
  const run = async (fn: () => Promise<any>) => { setErr(null); try { await fn(); plans.reload(); orgs.reload() } catch (x) { setErr(x) } }
  return (
    <Page title="Plataforma — planos e organizações">
      <Err e={err ?? plans.error} />
      <p className="muted">Os planos definem módulos e limites. Preços e cobrança recorrente não estão configurados (sem gateway); nenhuma transação é simulada.</p>
      <div className="tw"><table><thead><tr><th>Chave</th><th>Nome</th><th>Módulos</th><th>Limites</th><th>Ativo</th><th></th></tr></thead><tbody>{(plans.data?.items ?? []).map((p: any) => <tr key={p.id}><td>{p.key}</td><td>{p.name}</td><td>{p.modules.join(', ')}</td><td><code>{JSON.stringify(p.limits)}</code></td><td>{p.active ? 'sim' : 'não'}</td><td><button className="sec" onClick={() => run(() => put(`/admin/plans/${p.id}`, { active: !p.active }))}>{p.active ? 'Desativar' : 'Ativar'}</button></td></tr>)}</tbody></table></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Novo plano</h2><div className="form"><div className="field"><label>Chave</label><input value={np.key} onChange={(e) => setNp({ ...np, key: e.target.value })} /></div><div className="field"><label>Nome</label><input value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} /></div>
        <div className="field"><label>Módulos (vírgula)</label><input value={np.modules} onChange={(e) => setNp({ ...np, modules: e.target.value })} /></div><div className="field"><label>Limites (JSON)</label><input value={np.limits} onChange={(e) => setNp({ ...np, limits: e.target.value })} /></div></div>
        <button disabled={!np.key || !np.name} onClick={() => run(async () => { await post('/admin/plans', { key: np.key, name: np.name, modules: np.modules.split(',').map((x) => x.trim()).filter(Boolean), limits: JSON.parse(np.limits || '{}') }); setNp({ key: '', name: '', modules: '', limits: '{}' }) })}>Criar plano</button></div>
      <h2>Organizações</h2><div className="tw"><table><thead><tr><th>Nome</th><th>Plano</th><th>Cobrança</th><th>Alterar plano</th></tr></thead><tbody>{(orgs.data?.items ?? []).map((o: any) => <tr key={o.id}><td>{o.name}</td><td>{o.plan}</td><td>{o.billing_status}</td><td><select value={o.plan ?? ''} onChange={(e) => run(() => put(`/admin/organizations/${o.id}/plan`, { plan_key: e.target.value }))}>{(plans.data?.items ?? []).map((p: any) => <option key={p.id} value={p.key}>{p.key}</option>)}</select></td></tr>)}</tbody></table></div>
    </Page>
  )
}
