import { expect, type Page } from '@playwright/test'
export const E2E_EMAIL = 'e2e@example.com', E2E_PASSWORD = 'E2e-Senha-123!'

/** Falha o teste se houver erro de console, exceção na página ou resposta 5xx da API. */
export function watchErrors(page: Page) {
  const errs: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`) })
  return errs
}
let cached = ''
/** Login pela API uma vez por processo (o limitador de tentativas é por e-mail) e injeta o token como a própria SPA faz. */
export async function login(page: Page) {
  if (!cached) {
    const r = await page.request.post('/api/auth/login', { data: { email: E2E_EMAIL, password: E2E_PASSWORD }, headers: { Origin: 'http://localhost:8799' } })
    expect(r.status()).toBe(200); cached = (await r.json()).token
  }
  await page.addInitScript((t) => sessionStorage.setItem('nv_token', t), cached)
  await page.goto('/')
  await expect(page.locator('h1').first()).toBeVisible()
}
/** No celular o menu lateral começa recolhido. */
export async function openMenu(page: Page) {
  const btn = page.locator('.menu-btn')
  if (await btn.isVisible()) await btn.click()
}
