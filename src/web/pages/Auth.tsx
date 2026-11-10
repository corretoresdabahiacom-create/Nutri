import { useState } from 'react'
import { get, post, setToken } from '../api'
import { Err } from '../ui'

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [f, setF] = useState({ email: '', password: '', name: '', organization_name: '', plan_key: 'institucional', totp: '' })
  const [plans, setPlans] = useState<any[]>([]), [err, setErr] = useState<unknown>(null), [needMfa, setNeedMfa] = useState(false)
  const loadPlans = () => get('/plans').then((r) => setPlans(r.items ?? r)).catch(() => {})
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    try {
      const r = mode === 'login' ? await post('/auth/login', { email: f.email, password: f.password, totp: f.totp || undefined }) : await post('/auth/register', f)
      setToken(r.token); onDone()
    } catch (x: any) { if (x.code === 'mfa_required') setNeedMfa(true); setErr(x) }
  }
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value })
  return (
    <div className="login">
      <h1 style={{ marginBottom: 4 }}>NutriVida Pro</h1>
      <p className="muted">Nutrição esportiva, hospitalar, UAN, restaurantes, hotéis e resorts.</p>
      <form className="card" onSubmit={submit}>
        <Err e={err} />
        {mode === 'register' && <>
          <div className="field"><label>Seu nome</label><input value={f.name} onChange={set('name')} required /></div>
          <div className="field"><label>Organização</label><input value={f.organization_name} onChange={set('organization_name')} required /></div>
          <div className="field"><label>Plano</label><select value={f.plan_key} onFocus={() => !plans.length && loadPlans()} onChange={set('plan_key')}>{(plans.length ? plans : [{ key: 'institucional', name: 'Institucional' }]).map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}</select></div>
        </>}
        <div className="field"><label>E-mail</label><input type="email" value={f.email} onChange={set('email')} required autoComplete="username" /></div>
        <div className="field"><label>Senha {mode === 'register' && '(mín. 10 caracteres, letras e números)'}</label><input type="password" value={f.password} onChange={set('password')} required autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></div>
        {(needMfa || mode === 'login') && <div className="field"><label>Código de 2 fatores {needMfa ? '*' : '(se ativado)'}</label><input value={f.totp} onChange={set('totp')} inputMode="numeric" maxLength={6} /></div>}
        <div className="row"><button type="submit">{mode === 'login' ? 'Entrar' : 'Criar organização'}</button>
          <button type="button" className="sec" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Criar conta' : 'Já tenho conta'}</button></div>
      </form>
      <p className="muted" style={{ fontSize: 12 }}>Os planos e módulos são configuráveis; esta versão não realiza cobrança.</p>
    </div>
  )
}
