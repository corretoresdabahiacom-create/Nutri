import { Hono } from 'hono'
import { type AppEnv, requireAuth } from './lib/auth'
import { HttpError, type Env } from './lib/util'
import { authPrivate, authPublic } from './routes/auth'
import { core } from './routes/core'
import { foods } from './routes/foods'
import { recipes } from './routes/recipes'
import { sports } from './routes/sports'
import { hospital } from './routes/hospital'
import { uan } from './routes/uan'
import { menus, publicMenus } from './routes/menus'
import { ops } from './routes/ops'
import { exportsRoutes } from './routes/exports'
import { lgpd } from './routes/lgpd'
import { trends } from './routes/trends'
import { integrationsRoutes } from './routes/integrations'
import { inbound, publicCalendar } from './routes/inbound'
import { runDueJobs } from './lib/jobs'

const app = new Hono<AppEnv>()

app.use('/api/*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'no-referrer')
  c.header('X-Frame-Options', 'DENY')
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store')
})

const api = new Hono<AppEnv>()
api.route('/', authPublic)
api.route('/', publicMenus)
api.route('/', inbound)
api.route('/', publicCalendar)
/** Contrato de rotas em OpenAPI 3.0, gerado das rotas realmente registradas (não pode ficar desatualizado). Sem esquemas de corpo: ver docs/API.md. */
api.get('/openapi.json', (c) => {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of app.routes) {
    if (!r.path.startsWith('/api/') || r.method === 'ALL' || r.path.includes('*')) continue
    const path = r.path.slice(4).replace(/:([A-Za-z_]+)/g, '{$1}'), m = r.method.toLowerCase()
    const params = [...path.matchAll(/\{([A-Za-z_]+)\}/g)].map((x) => ({ name: x[1], in: 'path', required: true, schema: { type: 'string' } }))
    const pub = /^\/(auth\/(login|register|accept-invitation)|public|inbound|health|openapi)/.test(path)
    paths[path] ??= {}
    paths[path][m] = { tags: [path.split('/')[1] ?? 'root'], parameters: params, security: pub ? [] : [{ bearer: [] }], responses: { '200': { description: 'OK' }, '401': { description: 'Não autenticado' }, '403': { description: 'Sem permissão' }, '404': { description: 'Não encontrado ou fora do escopo' } } }
  }
  return c.json({ openapi: '3.0.3', info: { title: 'NutriVida Pro API', version: '0.1.0', description: 'Rotas geradas automaticamente. Autorização por permissão (RBAC) e isolamento por organização são aplicados no servidor; um recurso de outra organização responde 404.' }, servers: [{ url: '/api' }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } }, paths })
})

const priv = new Hono<AppEnv>()
priv.use('*', requireAuth)
priv.route('/', authPrivate)
priv.route('/', core)
priv.route('/', foods)
priv.route('/', recipes)
priv.route('/', sports)
priv.route('/', hospital)
priv.route('/', uan)
priv.route('/', menus)
priv.route('/', ops)
priv.route('/', exportsRoutes)
priv.route('/', integrationsRoutes)
priv.route('/', trends)
priv.route('/', lgpd)
api.route('/', priv)

app.route('/api', api)

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any)
  }
  console.error('erro_interno', err instanceof Error ? err.message : String(err))
  return c.json({ error: { code: 'internal_error', message: 'Erro interno' } }, 500)
})
app.notFound((c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) return c.json({ error: { code: 'not_found', message: 'Rota não encontrada' } }, 404)
  return c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Not found', 404)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDueJobs(env))
  }
}
export type { Env }
