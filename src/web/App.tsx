import type React from 'react'
import { useEffect, useState } from 'react'
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { get, hasToken, post, setToken } from './api'
import { ResourcePage } from './Resource'
import { RESOURCES } from './resources'
import { MeCtx, type Me } from './ui'
import { Login } from './pages/Auth'
import { Dashboard } from './pages/Dashboard'
import { Recipes } from './pages/Recipes'
import { Menus } from './pages/Menus'
import { MealOrders } from './pages/Hospital'
import { Production, Quality, Stock } from './pages/Ops'
import { Settings } from './pages/Settings'
import { Subject } from './pages/Subject'
import { Portal } from './pages/Portal'

const SPECIAL: { path: string; label: string; group: string; perm: string; el: React.ReactElement }[] = [
  { path: 'recipes', label: 'Fichas técnicas', group: 'Cadastros', perm: 'recipes.read', el: <Recipes /> },
  { path: 'menus', label: 'Cardápios', group: 'Cardápios', perm: 'menus.read', el: <Menus /> },
  { path: 'athlete-view', label: 'Acompanhamento', group: 'Esportiva', perm: 'sports.read', el: <Subject type="athlete" /> },
  { path: 'patient-view', label: 'Acompanhamento', group: 'Hospitalar', perm: 'clinical.read', el: <Subject type="patient" /> },
  { path: 'meal-orders', label: 'Pedidos de refeição', group: 'Hospitalar', perm: 'hospital.read', el: <MealOrders /> },
  { path: 'stock', label: 'Estoque', group: 'UAN', perm: 'stock.read', el: <Stock /> },
  { path: 'production', label: 'Produção', group: 'UAN', perm: 'production.read', el: <Production /> },
  { path: 'quality', label: 'Qualidade', group: 'Qualidade', perm: 'quality.read', el: <Quality /> }
]

export function App() {
  const [me, setMe] = useState<Me | null>(null), [authed, setAuthed] = useState(hasToken()), [open, setOpen] = useState(false)
  const load = () => get('/auth/me').then(setMe).catch(() => { setToken(null); setAuthed(false) })
  useEffect(() => { if (authed) load(); const f = () => { setMe(null); setAuthed(false) }; window.addEventListener('nv-logout', f); return () => window.removeEventListener('nv-logout', f) }, [authed])
  if (!authed) return <Login onDone={() => setAuthed(true)} />
  if (!me) return <p style={{ padding: 20 }}>Carregando…</p>
  const perms = new Set(me.permissions), can = (p: string) => perms.has(p)
  const portalOnly = can('portal.self') && perms.size === 1
  const items = [
    ...Object.entries(RESOURCES).filter(([, r]) => can(r.perm)).map(([k, r]) => ({ path: 'r/' + k, label: r.title.replace(/ \(.*\)/, ''), group: r.group })),
    ...SPECIAL.filter((s) => can(s.perm)).map((s) => ({ path: s.path, label: s.label, group: s.group }))
  ]
  const groups = [...new Set(items.map((i) => i.group))]
  const logout = async () => { try { await post('/auth/logout') } catch { /* ignore */ } setToken(null); setAuthed(false); setMe(null) }
  return (
    <MeCtx.Provider value={{ me, can, reload: load }}>
      <BrowserRouter>
        <div className="app">
          <nav className={'side' + (open ? ' open' : '')} onClick={() => setOpen(false)} aria-label="Navegação">
            <div className="brand"><i /> NutriVida Pro</div>
            {portalOnly ? <NavLink to="/portal">Meu portal</NavLink> : <><NavLink to="/" end>Painel</NavLink>
              {groups.map((g) => <div key={g}><div className="grp">{g}</div>{items.filter((i) => i.group === g).map((i) => <NavLink key={i.path} to={'/' + i.path}>{i.label}</NavLink>)}</div>)}
              <div className="grp">Conta</div><NavLink to="/settings">Configurações</NavLink></>}
            <a href="#" onClick={(e) => { e.preventDefault(); logout() }}>Sair ({me.user.name})</a>
          </nav>
          <main className="main">
            <button className="menu-btn sec no-print" onClick={() => setOpen(!open)} aria-label="Menu">☰ Menu</button>
            <Routes>
              <Route path="/" element={portalOnly ? <Navigate to="/portal" /> : <Dashboard />} />
              <Route path="/portal" element={<Portal />} />
              <Route path="/settings" element={<Settings />} />
              {Object.entries(RESOURCES).map(([k, r]) => <Route key={k} path={'/r/' + k} element={<ResourcePage cfg={r} />} />)}
              {SPECIAL.map((s) => <Route key={s.path} path={'/' + s.path} element={s.el} />)}
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </MeCtx.Provider>
  )
}
