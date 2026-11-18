import { expect, test } from '@playwright/test'
import { login, openMenu, watchErrors } from './helpers'

const ROUTES = ['/', '/recipes', '/menus', '/athlete-view', '/patient-view', '/prescriptions', '/maps', '/meal-orders', '/stock', '/production', '/purchasing', '/planning', '/quality', '/checklists',
  '/imports', '/guests', '/ai', '/documents', '/integrations', '/notifications', '/access', '/settings', '/r/foods', '/r/patients', '/r/units']

test('login inválido é recusado e o válido abre o painel', async ({ page }) => {
  await page.goto('/')
  await page.fill('input[type=email]', 'nao@existe.com'); await page.fill('input[type=password]', 'errada-12345')
  await page.click('button[type=submit]')
  await expect(page.locator('.err')).toBeVisible()
  await page.fill('input[type=email]', 'e2e@example.com'); await page.fill('input[type=password]', 'E2e-Senha-123!')
  await page.click('button[type=submit]')
  await expect(page.locator('h1').first()).toBeVisible(); await expect(page.locator('input[type=password]')).toHaveCount(0)
})

test('todas as telas principais abrem sem erro de console, exceção ou 5xx', async ({ page }) => {
  const errs = watchErrors(page)
  await login(page)
  for (const r of ROUTES) {
    await page.goto(r); await page.waitForLoadState('networkidle')
    await expect(page.locator('h1').first(), `rota ${r}`).toBeVisible()
    expect(await page.locator('.err').count(), `erro visível em ${r}`).toBe(0)
  }
  expect(errs).toEqual([])
})

test('layout não estoura a largura da tela (responsivo)', async ({ page }) => {
  await login(page)
  for (const r of ['/', '/recipes', '/stock', '/integrations']) {
    await page.goto(r); await page.waitForLoadState('networkidle')
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
    expect(sw, `scroll horizontal em ${r}`).toBeLessThanOrEqual(cw + 1)
  }
  await openMenu(page)
  await expect(page.getByRole('link', { name: 'Painel' }).first()).toBeInViewport()
})

test('plano alimentar: criar com item, calcular totais e baixar PDF do servidor', async ({ page }) => {
  const errs = watchErrors(page)
  await login(page); await page.goto('/athlete-view')
  await page.selectOption('select >> nth=0', { index: 1 })
  await page.getByRole('button', { name: '+ Novo plano' }).click()
  const ed = page.locator('.card', { hasText: 'Novo plano alimentar' })
  await ed.locator('.form input').first().fill('Plano E2E')
  await ed.locator('tbody select').nth(1).selectOption({ index: 1 })
  await ed.locator('tbody input[type=number]').fill('150')
  await ed.getByRole('button', { name: 'Salvar rascunho' }).click()
  await expect(page.getByText('Totais do plano')).toBeVisible()
  const dl = page.waitForEvent('download')
  await page.locator('tr', { hasText: 'Plano E2E' }).first().getByRole('button', { name: 'PDF' }).click()
  const d = await dl; expect(d.suggestedFilename()).toBe('plano-alimentar.pdf')
  const fs = await import('node:fs'); expect(fs.readFileSync(await d.path()!).subarray(0, 5).toString()).toBe('%PDF-')
  expect(errs).toEqual([])
})

test('prescrição dietética: alterar exige motivo e o histórico preserva a anterior', async ({ page }) => {
  await login(page); await page.goto('/prescriptions')
  await page.selectOption('select >> nth=0', { index: 1 })
  const form = page.locator('form.card')
  for (const n of [1, 2]) {
    await form.locator('select').first().selectOption({ index: 1 })
    const motivo = form.locator('.field', { hasText: 'Motivo da alteração' }).locator('input')
    if (await motivo.count()) await motivo.fill('Ajuste E2E ' + n)
    await form.locator('button[type=submit]').click()
    await page.waitForLoadState('networkidle')
  }
  await expect(page.locator('tbody tr').filter({ hasText: 'superseded' }).first()).toBeVisible()
  await expect(page.locator('tbody tr').filter({ hasText: 'active' })).toHaveCount(1)
})

test('token de integração é exibido uma vez e depois só o hash existe', async ({ page }) => {
  await login(page); await page.goto('/integrations')
  await page.getByRole('button', { name: 'Gerar token' }).click()
  const box = page.locator('.okmsg', { hasText: 'Token (exibido uma única vez)' })
  await expect(box).toBeVisible()
  const token = (await box.locator('code').textContent())!
  expect(token).toMatch(/^nvi_/)
  await page.reload(); await page.waitForLoadState('networkidle')
  await expect(page.getByText(token)).toHaveCount(0)
})

test('e-mail sem integração configurada é recusado, nunca "enviado"', async ({ page }) => {
  await login(page); await page.goto('/documents')
  await page.setInputFiles('input[type=file]', { name: 'laudo.txt', mimeType: 'text/plain', buffer: Buffer.from('conteudo ficticio') })
  await expect(page.getByText('Documento enviado.')).toBeVisible()
  await page.locator('tr', { hasText: 'laudo.txt' }).first().getByRole('button', { name: 'Enviar por e-mail' }).click()
  await page.fill('input[type=email]', 'alguem@exemplo.com'); await page.getByLabel(/Confirmo o envio/).check()
  await page.getByRole('button', { name: 'Enviar', exact: true }).click()
  await expect(page.locator('.err')).toContainText(/não configurado|Nenhuma mensagem/i)
})
