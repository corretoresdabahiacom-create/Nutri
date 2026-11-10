import { useState } from 'react'
import { get } from '../api'
import { Err, Kpi, Page, UnitSelect, fmt, money, today, useLoad, useMe } from '../ui'

function Block({ title, path, render }: { title: string; path: string; render: (d: any) => React.ReactNode }) {
  const { data, error } = useLoad(() => get(path), [path])
  return <div className="card"><h2 style={{ marginTop: 0 }}>{title}</h2><Err e={error} />{data ? <div className="grid">{render(data)}</div> : !error && <p className="muted">Carregando…</p>}</div>
}
export function Dashboard() {
  const { can, me } = useMe()
  const [unit, setUnit] = useState('')
  const mods = me.modules
  return (
    <Page title={`Painel — ${me.organization?.name ?? ''}`} actions={<UnitSelect value={unit} onChange={setUnit} />}>
      {can('sports.read') && <Block title="Nutrição esportiva" path="/dashboard/sports" render={(d) => <>
        <Kpi label="Atletas ativos" value={d.active_athletes} /><Kpi label="Avaliações (30 dias)" value={d.assessments_last_30d} /><Kpi label="Treinos (30 dias)" value={d.trainings_last_30d} />
        <Kpi label="Adesão (diário/plano)" value={d.adherence_pct == null ? '—' : fmt(d.adherence_pct, 1) + '%'} /><Kpi label="Variação média de peso (kg)" value={fmt(d.avg_weight_change_kg)} />
        <Kpi label="Competições (30 dias)" value={d.upcoming_competitions?.length} /></>} />}
      {can('hospital.read') && <Block title="Hospitalar — hoje" path="/dashboard/hospital" render={(d) => <>
        <Kpi label="Pacientes internados" value={d.admitted_patients} /><Kpi label="Pedidos do dia" value={d.orders_total} />
        <Kpi label="Pendentes com conflito CRÍTICO" value={d.pending_with_critical_conflict} tone={d.pending_with_critical_conflict ? 'bad' : undefined} />
        <Kpi label="Pendentes com alerta" value={d.pending_with_warning} tone={d.pending_with_warning ? 'warn' : undefined} /><Kpi label="Entregues" value={d.delivered_pct == null ? '—' : d.delivered_pct + '%'} /><Kpi label="Ocorrências abertas" value={d.open_occurrences} /></>} />}
      {unit && can('uan.read') && <Block title="UAN — indicadores" path={`/uan/kpis?unit_id=${unit}`} render={(d) => <>
        <Kpi label="Refeições servidas" value={fmt(d.meals_served, 0)} /><Kpi label="Custo real/porção" value={money(d.actual_cost_per_portion)} /><Kpi label="Custo planejado/porção" value={money(d.planned_cost_per_portion)} />
        <Kpi label="Desperdício (g)" value={fmt(d.waste_total_g, 0)} /><Kpi label="Ordens concluídas" value={d.production_orders_done} /></>} />}
      {unit && can('stock.read') && <Block title="Estoque" path={`/stock/balance?unit_id=${unit}`} render={(d) => <>
        <Kpi label="Valor em estoque" value={money(d.total_value)} /><Kpi label="Abaixo do mínimo" value={d.alerts.below_min} tone={d.alerts.below_min ? 'warn' : undefined} />
        <Kpi label="Com lote vencido" value={d.alerts.with_expired} tone={d.alerts.with_expired ? 'bad' : undefined} /><Kpi label="Vencendo em 7 dias" value={d.alerts.expiring_soon} tone={d.alerts.expiring_soon ? 'warn' : undefined} /></>} />}
      {unit && can('restaurant.read') && <Block title="Restaurante — margens" path={`/restaurant/margins?unit_id=${unit}`} render={(d) => <>
        <Kpi label="Receita (com custo completo)" value={money(d.totals.revenue_with_cost)} /><Kpi label="Custo" value={money(d.totals.cost)} /><Kpi label="Margem" value={d.totals.margin_pct == null ? '—' : d.totals.margin_pct + '%'} /></>} />}
      {can('quality.read') && <Block title="Qualidade e segurança alimentar" path="/dashboard/quality" render={(d) => <>
        <Kpi label="Não conformidades abertas" value={d.open_nonconformities} tone={d.open_nonconformities ? 'warn' : undefined} /><Kpi label="Temperaturas fora do limite (30d)" value={d.temperature_last_30d.out_of_range} tone={d.temperature_last_30d.out_of_range ? 'bad' : undefined} />
        <Kpi label="Nota média checklists" value={d.checklists_last_30d.avg_score ?? '—'} /><Kpi label="Recebimentos recusados" value={d.receiving_last_30d.refused} /></>} />}
      {can('reports.read') && <Block title="Consolidação multiunidade" path={`/consolidated/costs?from=${today().slice(0, 7)}-01`} render={(d) => <>
        <Kpi label="Unidades com movimento" value={d.units.length} /><Kpi label="Custo de produção" value={money(d.total.production_cost)} /><Kpi label="Custo/porção" value={money(d.total.cost_per_portion)} /><Kpi label="Receita" value={money(d.total.revenue)} /></>} />}
      {!mods.length && <p className="muted">Nenhum módulo habilitado.</p>}
    </Page>
  )
}
