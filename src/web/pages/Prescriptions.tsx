import { useState } from 'react'
import { get, post } from '../api'
import { Badge, Err, Page, today, useLoad, useMe } from '../ui'

const CONS = ['normal', 'branda', 'pastosa', 'liquida', 'liquida_espessada', 'triturada'], ROUTES = ['oral', 'enteral', 'parenteral']
/** Prescrição dietética hospitalar versionada: alterar uma vigente exige motivo e preserva o histórico. */
export function Prescriptions() {
  const { can } = useMe()
  const patients = useLoad(() => get('/patients'), []), types = useLoad(() => get('/diet-types'), [])
  const [pid, setPid] = useState(''), [err, setErr] = useState<unknown>(null)
  const rx = useLoad(() => (pid ? get(`/diet-prescriptions?patient_id=${pid}`) : Promise.resolve({ items: [] })), [pid])
  const [f, setF] = useState({ diet_type_id: '', consistency: 'normal', feeding_route: 'oral', restrictions: '', supplementation: '', notes: '', change_reason: '', valid_from: today() })
  const tname = (id: string) => (types.data?.items ?? []).find((t: any) => t.id === id)?.name ?? id.slice(0, 8)
  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    try { await post('/diet-prescriptions', { patient_id: pid, ...f, restrictions: list(f.restrictions), supplementation: list(f.supplementation), change_reason: f.change_reason || undefined, notes: f.notes || undefined }); setF({ ...f, change_reason: '', notes: '' }); rx.reload() } catch (x) { setErr(x) }
  }
  const active = (rx.data?.items ?? []).find((r: any) => r.status === 'active')
  return (
    <Page title="Prescrição dietética">
      <Err e={err ?? patients.error} />
      <div className="field" style={{ maxWidth: 380 }}><label>Paciente</label><select value={pid} onChange={(e) => setPid(e.target.value)}><option value="">Selecione…</option>{(patients.data?.items ?? []).filter((p: any) => p.status === 'admitted').map((p: any) => <option key={p.id} value={p.id}>{p.name} — {p.internal_code}</option>)}</select></div>
      {pid && can('hospital.prescribe') && <form className="card" onSubmit={save}>
        <h2 style={{ marginTop: 0 }}>{active ? 'Alterar prescrição vigente' : 'Nova prescrição'}</h2>
        <div className="form">
          <div className="field"><label>Tipo de dieta *</label><select required value={f.diet_type_id} onChange={(e) => setF({ ...f, diet_type_id: e.target.value })}><option value="">—</option>{(types.data?.items ?? []).filter((t: any) => t.active).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
          <div className="field"><label>Consistência</label><select value={f.consistency} onChange={(e) => setF({ ...f, consistency: e.target.value })}>{CONS.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Via de alimentação</label><select value={f.feeding_route} onChange={(e) => setF({ ...f, feeding_route: e.target.value })}>{ROUTES.map((c) => <option key={c}>{c}</option>)}</select></div>
          <div className="field"><label>Vigência desde</label><input type="date" value={f.valid_from} onChange={(e) => setF({ ...f, valid_from: e.target.value })} /></div>
          <div className="field"><label>Restrições (separe por vírgula)</label><input value={f.restrictions} onChange={(e) => setF({ ...f, restrictions: e.target.value })} /></div>
          <div className="field"><label>Suplementação (vírgula)</label><input value={f.supplementation} onChange={(e) => setF({ ...f, supplementation: e.target.value })} /></div>
          {active && <div className="field"><label>Motivo da alteração *</label><input required value={f.change_reason} onChange={(e) => setF({ ...f, change_reason: e.target.value })} /></div>}
          <div className="field"><label>Observações</label><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></div>
        </div>
        <button type="submit">{active ? 'Registrar alteração' : 'Prescrever'}</button>
        <p className="muted">A prescrição substitui a vigente e gera nova conferência nos pedidos de refeição pendentes. O sistema não define o que cada dieta significa: as regras vêm dos tipos de dieta da instituição.</p>
      </form>}
      {pid && <><h2>Histórico</h2><div className="tw"><table><thead><tr><th>Prescrita em</th><th>Dieta</th><th>Consistência</th><th>Via</th><th>Restrições</th><th>Status</th><th>Motivo</th></tr></thead>
        <tbody>{(rx.data?.items ?? []).map((r: any) => <tr key={r.id}><td>{String(r.prescribed_at).slice(0, 16).replace('T', ' ')}</td><td>{tname(r.diet_type_id)}</td><td>{r.consistency}</td><td>{r.feeding_route}</td><td>{(r.restrictions ?? []).join(', ')}</td><td><Badge v={r.status === 'active' ? 'ok' : 'warning'} text={r.status} /></td><td>{r.change_reason ?? ''}</td></tr>)}</tbody></table></div></>}
    </Page>
  )
}
