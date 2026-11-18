import { useState } from 'react'
import { get, post } from '../api'
import { Badge, Err, Page, fmt, useLoad, useMe } from '../ui'

/** IA assistiva determinística: mostra critérios, dados usados e exige decisão humana registrada. */
export function AiPage() {
  const { me, can } = useMe()
  const menus = useLoad(() => get('/menus'), []), recipes = useLoad(() => get('/recipes?limit=200'), []), foods = useLoad(() => get('/foods?limit=500'), []), sug = useLoad(() => get('/ai/suggestions'), [])
  const [err, setErr] = useState<unknown>(null), [menu, setMenu] = useState(''), [kcal, setKcal] = useState(''), [rc, setRc] = useState(''), [fd, setFd] = useState(''), [avoid, setAvoid] = useState(''), [last, setLast] = useState<any>(null)
  const detail = useLoad(() => (rc ? get(`/recipes/${rc}`) : Promise.resolve(null)), [rc])
  const run = async (fn: () => Promise<any>) => { setErr(null); try { setLast(await fn()); sug.reload() } catch (x) { setErr(x) } }
  if (!me.organization?.ai_enabled) return <Page title="IA assistiva"><div className="err">Recursos de IA desativados para esta organização. Um administrador pode ativá-los em Configurações.</div></Page>
  return (
    <Page title="IA assistiva (com validação humana)">
      <Err e={err ?? sug.error} />
      <p className="muted">Regras determinísticas e estatística simples sobre os dados da própria organização. Nenhum dado sai do sistema. A IA não altera prescrições, não aprova fichas e não publica cardápios.</p>
      <div className="card"><h2 style={{ marginTop: 0 }}>Revisar cardápio</h2><div className="row"><select value={menu} onChange={(e) => setMenu(e.target.value)}><option value="">Cardápio…</option>{(menus.data?.items ?? []).map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
        <input style={{ width: 160 }} placeholder="Meta kcal/dia (opcional)" value={kcal} onChange={(e) => setKcal(e.target.value)} /><button disabled={!menu} onClick={() => run(() => post('/ai/suggest/menu-review', { menu_id: menu, target_kcal_per_day: kcal ? Number(kcal) : undefined }))}>Analisar</button></div></div>
      <div className="card"><h2 style={{ marginTop: 0 }}>Sugerir substituição de ingrediente</h2><div className="row"><select value={rc} onChange={(e) => { setRc(e.target.value); setFd('') }}><option value="">Receita…</option>{(recipes.data?.items ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.name} v{r.version}</option>)}</select>
        <select value={fd} onChange={(e) => setFd(e.target.value)}><option value="">Ingrediente a substituir…</option>{(detail.data?.calc?.items ?? []).map((i: any) => <option key={i.food_id} value={i.food_id}>{i.food_name}</option>)}</select>
        <input style={{ width: 220 }} placeholder="Evitar alérgenos (vírgula)" value={avoid} onChange={(e) => setAvoid(e.target.value)} /><button disabled={!rc || !fd} onClick={() => run(() => post('/ai/suggest/substitution', { recipe_id: rc, food_id: fd, avoid_allergens: avoid.split(',').map((x) => x.trim()).filter(Boolean) }))}>Sugerir</button></div></div>
      {last && <div className="card"><h3 style={{ marginTop: 0 }}>Resultado</h3><Result s={last} foods={foods.data?.items ?? []} /></div>}
      <h2>Sugestões registradas</h2>
      <div className="tw"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Status</th><th></th></tr></thead><tbody>{(sug.data?.items ?? []).map((s: any) => <tr key={s.id}><td>{String(s.created_at).slice(0, 16).replace('T', ' ')}</td><td>{s.kind}</td><td><Badge v={s.status === 'accepted' ? 'ok' : s.status === 'rejected' ? 'critical' : 'warning'} text={s.status} /></td>
        <td className="row">{s.status === 'pending' && can('ai.review') && <><button onClick={() => run(async () => { await post(`/ai/suggestions/${s.id}/review`, { decision: 'accepted' }); return null })}>Aceitar (validação humana)</button><button className="bad" onClick={() => run(async () => { await post(`/ai/suggestions/${s.id}/review`, { decision: 'rejected' }); return null })}>Rejeitar</button></>}</td></tr>)}</tbody></table></div>
    </Page>
  )
}
function Result({ s }: { s: any; foods: any[] }) {
  return <div>
    <p className="muted">{s.disclosure}</p><p><b>Critérios:</b> {s.criteria}</p>
    {s.candidates && <div className="tw"><table><thead><tr><th>Candidato</th><th>Distância nutricional</th><th>Δ custo/porção</th><th>Fonte</th></tr></thead><tbody>{s.candidates.map((c: any) => <tr key={c.food_id}><td>{c.name}</td><td>{fmt(c.nutrient_distance, 3)}</td><td>{c.cost_delta_per_portion ?? 'sem preço'}</td><td>{c.source}</td></tr>)}</tbody></table></div>}
    {s.days && <div className="tw"><table><thead><tr><th>Dia</th><th>kcal</th><th>Proteína (g)</th><th>Custo</th></tr></thead><tbody>{s.days.map((d: any) => <tr key={d.date}><td>{d.date}</td><td>{d.kcal}</td><td>{d.protein_g}</td><td>{d.cost ?? 'incompleto'}</td></tr>)}</tbody></table></div>}
    {(s.flags ?? []).map((f: any, i: number) => <div key={i} className="err">{f.date}: {f.message}</div>)}{(s.notes ?? []).map((n: string, i: number) => <div key={i} className="muted">{n}</div>)}
    <p className="muted">Estado: pendente de validação humana. {s.data_sent_externally === false && 'Nenhum dado foi enviado a serviços externos.'}</p></div>
}
