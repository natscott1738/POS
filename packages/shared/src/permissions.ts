/**
 * Capability-based RBAC. Roles are *bundles of permissions*, never checked directly
 * in business logic — code always asks for a permission, so adding a role or
 * re-scoping one never requires touching a route handler.
 */

export const PERMISSIONS = [
  // Sales floor
  'sale:create',
  'sale:read',
  'sale:void',
  'sale:refund',
  'sale:discount:line',
  'sale:discount:order',
  'sale:reprint',
  'sale:price:override',

  // Cash handling
  'shift:open',
  'shift:close',
  'shift:read:own',
  'shift:read:all',
  'drawer:open',
  'drawer:adjust',

  // Catalog & stock
  'product:read',
  'product:write',
  'product:delete',
  'inventory:read',
  'inventory:adjust',
  'inventory:receive',
  'inventory:count',
  'inventory:transfer',

  // Customers
  'customer:read',
  'customer:write',
  'customer:delete',
  'loyalty:adjust',

  // Accounts receivable
  'credit:read',
  'credit:charge',
  'credit:collect',
  'credit:manage',

  // Payments
  'payment:mpesa:initiate',
  'payment:mpesa:reconcile',
  'payment:pdq:initiate',
  'payment:pdq:reconcile',
  'payment:refund',

  // Reporting
  'report:sales',
  'report:inventory',
  'report:payments',
  'report:tax',
  'report:export',

  // Integrations
  'quickbooks:connect',
  'quickbooks:sync',
  'quickbooks:map',

  // Administration
  'user:read',
  'user:write',
  'user:delete',
  'role:assign',
  'store:read',
  'store:write',
  'settings:read',
  'settings:write',
  'audit:read',
  'backup:read',
  'backup:run',
  'backup:restore',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ['ADMIN', 'MANAGER', 'CASHIER', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

const CASHIER: Permission[] = [
  'sale:create',
  'sale:read',
  'sale:reprint',
  'sale:discount:line',
  'shift:open',
  'shift:close',
  'shift:read:own',
  'drawer:open',
  'product:read',
  'inventory:read',
  'customer:read',
  'customer:write',
  'credit:read',
  'credit:charge',
  'credit:collect',
  'payment:mpesa:initiate',
  'payment:pdq:initiate',
];

const MANAGER: Permission[] = [
  ...CASHIER,
  'sale:void',
  'sale:refund',
  'sale:discount:order',
  'sale:price:override',
  'shift:read:all',
  'drawer:adjust',
  'product:write',
  'inventory:adjust',
  'inventory:receive',
  'inventory:count',
  'inventory:transfer',
  'customer:delete',
  'credit:read',
  'credit:manage',
  'loyalty:adjust',
  'payment:mpesa:reconcile',
  'payment:pdq:reconcile',
  'payment:refund',
  'report:sales',
  'report:inventory',
  'report:payments',
  'report:tax',
  'report:export',
  'quickbooks:sync',
  'user:read',
  'store:read',
  'settings:read',
];

const AUDITOR: Permission[] = [
  'sale:read',
  'product:read',
  'inventory:read',
  'customer:read',
  'credit:read',
  'shift:read:all',
  'report:sales',
  'report:inventory',
  'report:payments',
  'report:tax',
  'report:export',
  'audit:read',
  'store:read',
  'settings:read',
  'backup:read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  MANAGER: dedupe(MANAGER),
  CASHIER: dedupe(CASHIER),
  AUDITOR: dedupe(AUDITOR),
};

function dedupe(list: Permission[]): Permission[] {
  return [...new Set(list)];
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/**
 * Permissions that require a second, higher-privileged user to approve at the till
 * (manager override). Kept in shared code so the client can prompt before the
 * request is even sent — the server still enforces it independently.
 */
export const OVERRIDE_REQUIRED: readonly Permission[] = [
  'sale:void',
  'sale:refund',
  'sale:price:override',
  'sale:discount:order',
  'drawer:adjust',
  'inventory:adjust',
];
