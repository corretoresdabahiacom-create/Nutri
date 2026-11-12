import { useState } from 'react'
import { downloadFile, get, post } from '../api'
import { Badge, Err, Page, fmt, today, useLoad, useMe } from '../ui'
import { PlanEditor } from './PlanEditor'
import { Chart } from '../Chart'

/** Visão de um atleta/paciente: avaliações, comparação, suplementos (com alertas) e planos alimentares. */
export function Subject({ type }: { type: 'athlete' | 'patient' }) {
  const { can } = useMe()
  const list = useLoad(() => get(type === 'athlete' ? '/athletes' : '/patients'), [type])
  const [id, setId] = useState(''), [err, setErr] = useState<unknown>(null), [edit, setEdit] = useState<any>(null)
  const q = `subject_type=${type}&subject_id=${id}`
  const ass = useLoad(() => (id ? get(`/assessments?${q}`) : Promise.resolve({ items: [] })), [id])
  const sup = useLoad(() => (id && type === 'athlete' ? get(`/supplements?${q}`) : Promise.resolve({ items: [] })), [id])
  const plans = useLoad(() => (id ? get(`/meal-plans?${q}`) : Promise.resolve({ items: [] })), [id])
  const [a, setA] = useState({ date: today(), weight_kg: '', body_fat_pct: '' }), [s, setS] = useState({ product: '', ingredient: '', dose: '', override_reason: '' }), [cmp, setCmp] = useState<any>(null)
  const run = async (fn: () => Promise<any>, then: () => void) => { setErr(null); try { await fn(); then() } catch (x) { setErr(x) } }
  const write = can(type === 'athlete' ? 'sports.write' : 'clinical.write')
  return (
    <Page title={type === 'athlete' ? 'Atletas — acompanhamento' : 'Pacientes — acompanhamento'}>
      <Err e={err ?? list.error} />
      <div className="field" style={{ maxWidth: 360 }}><label>{type === 'athlete' ? 'Atleta' : 'Paciente'}</label><select value={id} onChange={(e) => { setId(e.target.value); setCmp(null) }}><option value="">Selecione…</option>{(list.data?.items ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
      {id && <>
        <h2>Avaliações</h2>
        {write && <div className="card row"><input type="date" style={{ width: 160 }} value={a.date} onChange={(e) => setA({ ...a, date: e.target.value })} /><input style={{ width: 120 }} placeholder="Peso (kg)" value={a.weight_kg} onChange={(e) => setA({ ...a, weight_kg: e.target.value })} /><input style={{ width: 120 }} placeholder="% gordura" value={a.body_fat_pct} onChange={(e) => setA({ ...a, body_fat_pct: e.target.value })} />
          <button onClick={() => run(() => post('/assessments', { subject_type: type, subject_id: id, date: a.date, weight_kg: a.weight_kg ? Number(a.weight_kg) : null, body_fat_pct: a.body_fat_pct ? Number(a.body_fat_pct) : null }), ass.reload)}>Registrar</button></div>}
        <div className="tw"><table><thead><tr><th>Data</th><th>Peso</th><th>% gordura</th></tr></thead><tbody>{(ass.data?.items ?? []).map((x: any) => <tr key={x.id}><td>{x.date}</td><td>{fmt(x.weight_kg)}</td><td>{fmt(x.body_fat_pct)}</td></tr>)}</tbody></table></div>
        {(ass.data?.items?.length ?? 0) >= 2 && <div className="card"><Chart title="Evolução do peso" unit="kg" points={[...ass.data.items].filter((x: any) => x.weight_kg != null).sort((a: any, b: any) => a.date.localeCompare(b.date)).map((x: any) => ({ label: x.date, value: Number(x.weight_kg) }))} /></div>}
        {(ass.data?.items?.length ?? 0) >= 2 && <div className="row" style={{ marginTop: 8 }}><button className="sec" onClick={() => run(async () => setCmp(await get(`/assessments-compare?a=${ass.data.items[0].id}&b=${ass.data.items[ass.data.items.length - 1].id}`)), () => {})}>Comparar primeira × última</button>
          {cmp && <span>{cmp.from_date} → {cmp.to_date}: peso {fmt(cmp.diff.weight_kg.delta)} kg • gordura {fmt(cmp.diff.body_fat_pct.delta)} p.p.</span>}</div>}
        {type === 'athlete' && <><h2>Suplementação</h2>
          {can('sports.supplements') && <div className="card form">{(['product', 'ingredient', 'dose', 'override_reason'] as const).map((k) => <div className="field" key={k}><label>{({ product: 'Produto', ingredient: 'Substância/ingrediente', dose: 'Dose', override_reason: 'Justificativa (se houver alerta proibido)' })[k]}</label><input value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })} /></div>)}
            <div className="field"><label>&nbsp;</label><button onClick={() => run(() => post('/supplements', { subject_type: type, subject_id: id, ...s, override_reason: s.override_reason || undefined }), sup.reload)}>Prescrever</button></div></div>}
          <div className="tw"><table><thead><tr><th>Produto</th><th>Dose</th><th>Alertas</th></tr></thead><tbody>{(sup.data?.items ?? []).map((x: any) => <tr key={x.id}><td>{x.product}<br /><small className="muted">{x.ingredient}</small></td><td>{x.dose}</td><td>{(x.warnings ?? []).map((w: any, i: number) => <div key={i}><Badge v={w.severity === 'prohibited' ? 'critical' : w.severity === 'warning' ? 'warning' : 'ok'} text={w.severity} /> {w.name ?? w.message} {w.source && <small className="muted">({w.source})</small>}</div>)}</td></tr>)}</tbody></table></div></>}
        <h2>Planos alimentares</h2>
        <div className="tw"><table><thead><tr><th>Nome</th><th>Status</th><th></th></tr></thead><tbody>{(plans.data?.items ?? []).map((p: any) => <tr key={p.id}><td>{p.name}</td><td><Badge v={p.status} /></td><td className="row">
          <button className="sec" onClick={() => downloadFile(`/meal-plans/${p.id}/export.pdf`, 'plano-alimentar.pdf').catch(setErr)}>PDF</button>{p.status === 'draft' && write && <button className="sec" onClick={async () => setEdit(await get(`/meal-plans/${p.id}`))}>Editar</button>}{p.status === 'draft' && <button onClick={() => run(() => post(`/meal-plans/${p.id}/approve`), plans.reload)}>Aprovar</button>}{p.status !== 'draft' && write && <button className="sec" onClick={() => run(() => post(`/meal-plans/${p.id}/revise`), plans.reload)}>Revisar</button>}</td></tr>)}</tbody></table></div>
        {write && !edit && <button style={{ marginTop: 8 }} onClick={() => setEdit({})}>+ Novo plano</button>}
        {edit && <PlanEditor key={edit.id ?? 'new'} type={type} subjectId={id} plan={edit.id ? edit : undefined} onSaved={plans.reload} onCancel={() => setEdit(null)} />}
        <p className="muted">A aprovação bloqueia itens que conflitam com alergias registradas.</p></>}
    </Page>
  )
}
