import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { get } from './api'

export interface Me {
  user: { id: string; email: string; name: string; mfa_enabled: boolean; is_platform_admin?: boolean }
  organization: { id: string; name: string; ai_enabled: boolean; require_mfa: boolean; plan: string } | null
  modules: string[]; permissions: string[]
}
export const MeCtx = createContext<{ me: Me; can: (p: string) => boolean; reload: () => void } | null>(null)
export const useMe = () => useContext(MeCtx)!

export function Err({ e }: { e: unknown }) {
  if (!e) return null
  const x = e as any
  return <div className="err" role="alert"><b>{x.message ?? String(e)}</b>{Array.isArray(x.details) && <ul>{x.details.slice(0, 8).map((d: any, i: number) => <li key={i}>{typeof d === 'string' ? d : d.message ?? JSON.stringify(d)}</li>)}</ul>}</div>
}
export function Badge({ v, text }: { v: string; text?: string }) { return <span className={`badge ${v}`}>{text ?? v}</span> }
export function Kpi({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' | 'bad' }) { return <div className={`kpi ${tone ?? ''}`}><b>{value ?? '—'}</b><span>{label}</span></div> }
export function Page({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return <><div className="top"><h1>{title}</h1><div className="row">{actions}</div></div>{children}</>
}

export interface Unit { id: string; name: string; kind: string }
export function useUnits() {
  const [units, setUnits] = useState<Unit[]>([])
  useEffect(() => { get('/units').then((r) => setUnits(r.items)).catch(() => {}) }, [])
  return units
}
export function UnitSelect({ value, onChange, kinds, allowEmpty }: { value: string; onChange: (v: string) => void; kinds?: string[]; allowEmpty?: boolean }) {
  const units = useUnits().filter((u) => !kinds || kinds.includes(u.kind))
  useEffect(() => { if (!value && !allowEmpty && units[0]) onChange(units[0].id) }, [units.length])
  return <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Unidade">{allowEmpty && <option value="">Todas</option>}{units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
}
export const fmt = (n: unknown, d = 2) => (n == null || n === '' ? '—' : Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: d }))
export const money = (n: unknown) => (n == null ? '—' : Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))
export const today = () => new Date().toISOString().slice(0, 10)

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null), [error, setError] = useState<unknown>(null), [loading, setLoading] = useState(true)
  const [n, setN] = useState(0)
  useEffect(() => { let live = true; setLoading(true); fn().then((d) => { if (live) { setData(d); setError(null) } }).catch((e) => live && setError(e)).finally(() => live && setLoading(false)); return () => { live = false } }, [...deps, n])
  return { data, error, loading, reload: () => setN((x) => x + 1) }
}
