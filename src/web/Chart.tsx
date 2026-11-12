import { fmt } from './ui'

export interface Point { label: string; value: number }
/** Gráfico SVG sem biblioteca: linha ou barras, com título, descrição e tabela de dados alternativa para leitores de tela. */
export function Chart({ title, unit, points, kind = 'line', height = 180 }: { title: string; unit?: string; points: Point[]; kind?: 'line' | 'bar'; height?: number }) {
  if (!points.length) return <p className="muted">Sem dados registrados no período para “{title}”.</p>
  const W = 640, H = height, L = 46, R = 10, T = 10, B = 24
  const max = Math.max(...points.map((p) => p.value)), min = Math.min(0, ...points.map((p) => p.value)), span = max - min || 1
  const x = (i: number) => L + (points.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (points.length - 1))
  const y = (v: number) => T + (1 - (v - min) / span) * (H - T - B)
  const bw = Math.max(3, Math.min(28, ((W - L - R) / points.length) * 0.7))
  const ticks = [min, min + span / 2, max]
  const id = 'c' + title.replace(/\W/g, '').slice(0, 12)
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={id + 't ' + id + 'd'} style={{ width: '100%', height: 'auto', maxHeight: H + 40 }}>
        <title id={id + 't'}>{title}</title>
        <desc id={id + 'd'}>{`${points.length} pontos de ${points[0].label} a ${points[points.length - 1].label}; mínimo ${fmt(Math.min(...points.map((p) => p.value)))} ${unit ?? ''}, máximo ${fmt(max)} ${unit ?? ''}.`}</desc>
        {ticks.map((t, i) => <g key={i}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--mute)">{fmt(t, 1)}</text></g>)}
        {kind === 'bar'
          ? points.map((p, i) => <rect key={i} x={x(i) - bw / 2} y={Math.min(y(p.value), y(0))} width={bw} height={Math.abs(y(0) - y(p.value)) || 1} fill="var(--green)" rx="2"><title>{`${p.label}: ${fmt(p.value)} ${unit ?? ''}`}</title></rect>)
          : <><polyline fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinejoin="round" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />
            {points.map((p, i) => <circle key={i} cx={x(i)} cy={y(p.value)} r="3.5" fill="var(--green-d)"><title>{`${p.label}: ${fmt(p.value)} ${unit ?? ''}`}</title></circle>)}</>}
        <text x={L} y={H - 6} fontSize="11" fill="var(--mute)">{points[0].label}</text><text x={W - R} y={H - 6} fontSize="11" fill="var(--mute)" textAnchor="end">{points[points.length - 1].label}</text>
      </svg>
      <details className="no-print"><summary>Ver dados em tabela</summary><div className="tw"><table><thead><tr><th>Data</th><th>{unit ?? 'Valor'}</th></tr></thead><tbody>{points.map((p, i) => <tr key={i}><td>{p.label}</td><td>{fmt(p.value)}</td></tr>)}</tbody></table></div></details>
    </figure>
  )
}
