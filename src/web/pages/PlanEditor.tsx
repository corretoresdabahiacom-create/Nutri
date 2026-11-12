import { useState } from 'react'
import { get, post, put } from '../api'
import { Badge, Err, fmt, useLoad } from '../ui'

interface Row { meal_name: string; meal_time: string; kind: 'food' | 'recipe'; ref: string; qty_g: string; notes: string }
const blank = (): Row => ({ meal_name: 'Café da manhã', meal_time: '', kind: 'food', ref: '', qty_g: '', notes: '' })

/** Editor de plano alimentar (rascunho): itens por refeição, totais nutricionais e conflitos de alergia vindos do backend. */
export function PlanEditor({ type, subjectId, plan, onSaved, onCancel }: { type: 'athlete' | 'patient'; subjectId: string; plan?: any; onSaved: () => void; onCancel: () => void }) {
  const foods = useLoad(() => get('/foods?limit=500'), []), recipes = useLoad(() => get('/recipes'), [])
  const [name, setName] = useState(plan?.name ?? ''), [validFrom, setVF] = useState(plan?.valid_from ?? ''), [notes, setNotes] = useState(plan?.notes ?? '')
  const [rows, setRows] = useState<Row[]>(plan?.items?.map((i: any) => ({ meal_name: i.meal_name, meal_time: i.meal_time ?? '', kind: i.recipe_id ? 'recipe' : 'food', ref: i.recipe_id ?? i.food_id, qty_g: String(i.qty_g), notes: i.notes ?? '' })) ?? [blank()])
  const [err, setErr] = useState<unknown>(null), [saved, setSaved] = useState<any>(null)
  const upd = (i: number, p: Partial<Row>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...p } : r)))
  const save = async () => {
    setErr(null)
    const body = { subject_type: type, subject_id: subjectId, name, valid_from: validFrom || undefined, notes: notes || undefined,
      items: rows.filter((r) => r.ref && r.qty_g).map((r) => ({ meal_name: r.meal_name, meal_time: r.meal_time || undefined, [r.kind === 'food' ? 'food_id' : 'recipe_id']: r.ref, qty_g: Number(r.qty_g), notes: r.notes || undefined })) }
    try {
      const res = plan ? await put(`/meal-plans/${plan.id}`, body) : await post('/meal-plans', body)
      const id = plan?.id ?? res.id
      setSaved(await get(`/meal-plans/${id}`)); onSaved()
    } catch (x) { setErr(x) }
  }
  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>{plan ? 'Editar rascunho' : 'Novo plano alimentar'}</h2><Err e={err} />
      <div className="form"><div className="field"><label>Nome *</label><input value={name} onChange={(e) => setName(e.target.value)} /></div><div className="field"><label>Vigência desde</label><input type="date" value={validFrom} onChange={(e) => setVF(e.target.value)} /></div></div>
      <div className="tw"><table><thead><tr><th>Refeição</th><th>Horário</th><th>Tipo</th><th>Item</th><th>Qtd (g)</th><th></th></tr></thead><tbody>
        {rows.map((r, i) => <tr key={i}>
          <td><input value={r.meal_name} onChange={(e) => upd(i, { meal_name: e.target.value })} /></td>
          <td><input type="time" value={r.meal_time} onChange={(e) => upd(i, { meal_time: e.target.value })} /></td>
          <td><select value={r.kind} onChange={(e) => upd(i, { kind: e.target.value as Row['kind'], ref: '' })}><option value="food">Alimento</option><option value="recipe">Receita</option></select></td>
          <td><select value={r.ref} onChange={(e) => upd(i, { ref: e.target.value })}><option value="">—</option>{((r.kind === 'food' ? foods.data?.items : recipes.data?.items) ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></td>
          <td><input type="number" step="any" style={{ width: 90 }} value={r.qty_g} onChange={(e) => upd(i, { qty_g: e.target.value })} /></td>
          <td><button className="bad" onClick={() => setRows(rows.filter((_, k) => k !== i))} aria-label="Remover item">×</button></td></tr>)}
      </tbody></table></div>
      <div className="row" style={{ marginTop: 8 }}><button className="sec" onClick={() => setRows([...rows, { ...blank(), meal_name: rows[rows.length - 1]?.meal_name ?? 'Refeição' }])}>+ Item</button><button disabled={!name} onClick={save}>Salvar rascunho</button><button className="sec" onClick={onCancel}>Fechar</button></div>
      {saved && <div style={{ marginTop: 10 }}><b>Totais do plano (calculados só com dados com fonte):</b> {['energy_kcal', 'protein_g', 'carb_g', 'fat_g'].map((k) => <span key={k} style={{ marginRight: 12 }}>{k}: {fmt(saved.nutrition_total?.[k])}</span>)}
        {(saved.allergy_conflicts ?? []).length > 0 && <div className="err" style={{ marginTop: 6 }}>{saved.allergy_conflicts.map((c: any, i: number) => <div key={i}><Badge v="critical" text="alergia" /> {c.item ?? c.food_name ?? ''} {c.allergen ?? c.message ?? ''}</div>)}<small>A aprovação será bloqueada enquanto houver conflito.</small></div>}</div>}
    </div>
  )
}
