/** Catálogo de permissões, módulos e modelos de papéis. Toda checagem é feita no backend. */

export const MODULES = ['core', 'sports', 'clinical', 'uan', 'restaurant', 'hotel', 'resort', 'quality', 'ai', 'portal'] as const
export type Module = (typeof MODULES)[number]

/** Prefixo da permissão -> módulos (qualquer um habilita). */
const FOODSERVICE: Module[] = ['uan', 'restaurant', 'hotel', 'resort', 'clinical']
const PREFIX_MODULES: Record<string, Module[]> = {
  org: ['core'], users: ['core'], roles: ['core'], units: ['core'], audit: ['core'], docs: ['core'], notifications: ['core'],
  foods: ['core'], recipes: ['core'], suppliers: ['core'], prices: ['core'], budget: ['core'], events: ['core'], reports: ['core'],
  integrations: ['core'], lgpd: ['core'],
  sports: ['sports'],
  clinical: ['clinical'], hospital: ['clinical'],
  uan: ['uan'],
  stock: FOODSERVICE, purchase: FOODSERVICE, production: FOODSERVICE, menus: FOODSERVICE,
  restaurant: ['restaurant'],
  hospitality: ['hotel', 'resort'], guests: ['hotel', 'resort'],
  quality: ['quality'],
  ai: ['ai'],
  portal: ['portal']
}
export function modulesForPerm(perm: string): Module[] {
  return PREFIX_MODULES[perm.split('.')[0]] ?? ['core']
}

export const ALL_PERMS = [
  'org.manage', 'users.manage', 'roles.manage', 'units.manage', 'audit.read', 'docs.read', 'docs.write', 'notifications.read',
  'foods.read', 'foods.write', 'recipes.read', 'recipes.write', 'recipes.approve', 'suppliers.read', 'suppliers.write',
  'prices.write', 'budget.manage', 'events.read', 'events.write', 'reports.read', 'reports.export', 'integrations.manage', 'lgpd.manage',
  'sports.read', 'sports.write', 'sports.approve', 'sports.supplements',
  'clinical.read', 'clinical.write', 'hospital.read', 'hospital.prescribe', 'hospital.confer', 'hospital.release',
  'hospital.produce', 'hospital.deliver', 'hospital.manage',
  'uan.read', 'uan.write', 'stock.read', 'stock.write', 'purchase.read', 'purchase.write', 'purchase.approve',
  'production.read', 'production.write',
  'menus.read', 'menus.write', 'menus.approve', 'menus.publish',
  'restaurant.read', 'restaurant.write', 'hospitality.read', 'hospitality.write', 'guests.read', 'guests.write',
  'quality.read', 'quality.write', 'ai.use', 'ai.review', 'portal.self'
] as const
export type Perm = (typeof ALL_PERMS)[number]

const p = (...x: string[]) => x
const RW = (n: string) => [`${n}.read`, `${n}.write`]
const CLINICAL = ['clinical.read', 'clinical.write']

export const ROLE_TEMPLATES: { key: string; name: string; permissions: string[] }[] = [
  { key: 'administrador', name: 'Administrador', permissions: [...ALL_PERMS].filter((x) => x !== 'portal.self') },
  {
    key: 'responsavel_tecnico', name: 'Responsável técnico',
    permissions: [...ALL_PERMS].filter((x) => !['portal.self', 'org.manage', 'roles.manage'].includes(x))
  },
  {
    key: 'nutricionista', name: 'Nutricionista',
    permissions: p('foods.read', 'foods.write', 'recipes.read', 'recipes.write', 'events.read', 'events.write', 'reports.read', 'docs.read', 'docs.write',
      'sports.read', 'sports.write', 'sports.approve', 'sports.supplements', 'menus.read', 'menus.write', 'notifications.read', 'ai.use')
  },
  {
    key: 'nutricionista_clinico', name: 'Nutricionista clínico',
    permissions: p('foods.read', 'recipes.read', 'events.read', 'events.write', 'docs.read', 'docs.write', ...CLINICAL, 'hospital.read',
      'hospital.prescribe', 'reports.read', 'notifications.read', 'ai.use')
  },
  {
    key: 'nutricionista_esportivo', name: 'Nutricionista esportivo',
    permissions: p('foods.read', 'foods.write', 'recipes.read', 'recipes.write', 'events.read', 'events.write', 'docs.read', 'docs.write',
      'sports.read', 'sports.write', 'sports.approve', 'sports.supplements', 'reports.read', 'notifications.read', 'ai.use')
  },
  {
    key: 'nutricionista_hospitalar', name: 'Nutricionista hospitalar',
    permissions: p('foods.read', 'recipes.read', 'recipes.write', 'menus.read', 'production.read', 'events.read', 'events.write', 'docs.read',
      'docs.write', ...CLINICAL, 'hospital.read', 'hospital.prescribe', 'hospital.confer', 'hospital.release', 'hospital.manage',
      'reports.read', 'reports.export', 'notifications.read', 'ai.use')
  },
  {
    key: 'nutricionista_uan', name: 'Nutricionista de UAN',
    permissions: p('foods.read', 'foods.write', 'recipes.read', 'recipes.write', 'recipes.approve', 'menus.read', 'menus.write', 'menus.approve',
      'menus.publish', 'uan.read', 'uan.write', 'stock.read', 'stock.write', 'purchase.read', 'purchase.write', 'production.read',
      'production.write', 'quality.read', 'quality.write', 'reports.read', 'reports.export', 'suppliers.read', 'suppliers.write',
      'prices.write', 'budget.manage', 'events.read', 'events.write', 'docs.read', 'docs.write', 'notifications.read', 'ai.use')
  },
  {
    key: 'chef', name: 'Chef',
    permissions: p('foods.read', 'foods.write', 'recipes.read', 'recipes.write', 'menus.read', 'menus.write', 'stock.read', 'production.read',
      'production.write', 'quality.read', 'quality.write', 'guests.read', 'restaurant.read', 'restaurant.write', 'hospitality.read',
      'suppliers.read', 'docs.read', 'events.read', 'notifications.read', 'ai.use')
  },
  {
    key: 'cozinheiro', name: 'Cozinheiro',
    permissions: p('recipes.read', 'menus.read', 'production.read', 'production.write', 'stock.read', 'quality.read', 'quality.write',
      'guests.read', 'hospital.read', 'hospital.produce', 'hospital.deliver', 'notifications.read')
  },
  {
    key: 'auxiliar_cozinha', name: 'Auxiliar de cozinha',
    permissions: p('recipes.read', 'production.read', 'stock.read', 'quality.write', 'quality.read', 'hospital.read', 'hospital.produce',
      'hospital.deliver', 'notifications.read')
  },
  {
    key: 'estoquista', name: 'Estoquista',
    permissions: p('stock.read', 'stock.write', 'purchase.read', 'suppliers.read', 'foods.read', 'quality.read', 'quality.write',
      'production.read', 'notifications.read')
  },
  {
    key: 'comprador', name: 'Comprador',
    permissions: p('purchase.read', 'purchase.write', 'suppliers.read', 'suppliers.write', 'prices.write', 'stock.read', 'foods.read',
      'notifications.read')
  },
  {
    key: 'gestor', name: 'Gestor',
    permissions: p('foods.read', 'recipes.read', 'menus.read', 'uan.read', 'stock.read', 'purchase.read', 'purchase.approve', 'production.read',
      'quality.read', 'restaurant.read', 'hospitality.read', 'reports.read', 'reports.export', 'budget.manage', 'suppliers.read',
      'events.read', 'docs.read', 'notifications.read', 'ai.use')
  },
  {
    key: 'recepcionista', name: 'Recepcionista',
    permissions: p('events.read', 'events.write', 'docs.read', 'hospitality.read', 'guests.write', 'notifications.read')
  },
  { key: 'assistente', name: 'Assistente', permissions: p('events.read', 'events.write', 'docs.read', 'docs.write', 'notifications.read') },
  {
    key: 'auditor', name: 'Auditor',
    permissions: p('audit.read', 'reports.read', 'quality.read', 'recipes.read', 'menus.read', 'stock.read', 'production.read', 'uan.read',
      'hospital.read', 'foods.read', 'docs.read', 'notifications.read')
  },
  {
    key: 'somente_leitura', name: 'Consulta somente leitura',
    permissions: p('foods.read', 'recipes.read', 'menus.read', 'events.read', 'reports.read', 'notifications.read')
  },
  { key: 'paciente_portal', name: 'Portal (paciente/atleta)', permissions: p('portal.self') }
]

export const DEFAULT_PLANS = [
  { key: 'individual', name: 'Individual', modules: ['core', 'sports', 'portal'], limits: { max_units: 1, max_users: 2, max_patients: 100 } },
  { key: 'profissional', name: 'Profissional', modules: ['core', 'sports', 'clinical', 'portal', 'ai'], limits: { max_units: 3, max_users: 15, max_patients: 1000 } },
  { key: 'institucional', name: 'Institucional', modules: ['core', 'clinical', 'uan', 'quality', 'portal', 'ai'], limits: { max_units: 20, max_users: 200, max_patients: 5000 } },
  { key: 'foodservice', name: 'Foodservice', modules: ['core', 'restaurant', 'hotel', 'resort', 'uan', 'quality', 'portal', 'ai'], limits: { max_units: 50, max_users: 300, max_patients: 0 } },
  { key: 'enterprise', name: 'Enterprise', modules: [...MODULES], limits: { max_units: 1000, max_users: 5000, max_patients: 100000 } }
]
