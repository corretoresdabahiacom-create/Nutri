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
