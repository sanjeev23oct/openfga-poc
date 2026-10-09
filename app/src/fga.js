// Thin wrapper around the OpenFGA SDK. Counts calls so the UI can show what each request cost.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OpenFgaClient } from '@openfga/sdk';

export const API_URL = process.env.FGA_API_URL ?? 'http://localhost:8080';
export const STORE_FILE = fileURLToPath(new URL('../.fga-store.json', import.meta.url));

export const PERMISSIONS = ['can_view_basic', 'can_edit_basic', 'can_view_salary'];

export function loadStoreConfig() {
  if (!existsSync(STORE_FILE)) {
    throw new Error('No store found. Run `npm run setup` first.');
  }
  return JSON.parse(readFileSync(STORE_FILE, 'utf8'));
}

export function createClient(config = loadStoreConfig()) {
  return new OpenFgaClient({
    apiUrl: API_URL,
    storeId: config.storeId,
    authorizationModelId: config.modelId,
  });
}

// Collects the OpenFGA calls made while serving one API request.
export class Trace {
  calls = [];

  async run(name, detail, fn) {
    const started = performance.now();
    try {
      return await fn();
    } finally {
      this.calls.push({ name, detail, ms: Math.round((performance.now() - started) * 10) / 10 });
    }
  }

  summary() {
    return {
      fgaCalls: this.calls.length,
      fgaMs: Math.round(this.calls.reduce((sum, c) => sum + c.ms, 0) * 10) / 10,
      calls: this.calls,
    };
  }
}

// The department always comes from the HR record, never from the caller.
const departmentContext = (department) => ({ employee_department: department });

export async function checkEmployee(fga, trace, user, permission, employee) {
  const { allowed } = await trace.run('Check', `${user} ${permission} employee:${employee.id}`, () =>
    fga.check({
      user: `user:${user}`,
      relation: permission,
      object: `employee:${employee.id}`,
      context: departmentContext(employee.department),
    }),
  );
  return Boolean(allowed);
}

// Strategy 1, "search then check": one BatchCheck covering every employee and permission.
export async function permissionsByBatchCheck(fga, trace, user, employees) {
  // Correlation ids may only hold letters, digits, _ and -, so each check is keyed by its position.
  const keys = employees.flatMap((employee) =>
    PERMISSIONS.map((permission) => ({ employee, permission })),
  );
  const checks = keys.map(({ employee, permission }, index) => ({
    user: `user:${user}`,
    relation: permission,
    object: `employee:${employee.id}`,
    context: departmentContext(employee.department),
    correlationId: String(index),
  }));
  const { result } = await trace.run('BatchCheck', `${checks.length} checks`, () =>
    fga.batchCheck({ checks }),
  );
  const permissions = new Map(employees.map((e) => [e.id, emptyPermissions()]));
  for (const item of result) {
    const { employee, permission } = keys[Number(item.correlationId)];
    permissions.get(employee.id)[permission] = Boolean(item.allowed);
  }
  return permissions;
}

// Strategy 2, "list ids then search": ask which employees the user can reach.
// The condition needs a department, so there is one ListObjects per department and permission.
export async function permissionsByListObjects(fga, trace, user, employees, departments) {
  const permissions = new Map(employees.map((e) => [e.id, emptyPermissions()]));
  await Promise.all(
    departments.flatMap((department) =>
      PERMISSIONS.map(async (permission) => {
        const { objects } = await trace.run(
          'ListObjects',
          `employee ${permission} [${department}]`,
          () =>
            fga.listObjects({
              user: `user:${user}`,
              relation: permission,
              type: 'employee',
              context: departmentContext(department),
            }),
        );
        const reachable = new Set(objects.map((o) => o.split(':')[1]));
        // The answer assumed every employee is in `department`; keep only those that are.
        for (const employee of employees) {
          if (employee.department === department && reachable.has(employee.id)) {
            permissions.get(employee.id)[permission] = true;
          }
        }
      }),
    ),
  );
  return permissions;
}

// Strategy 3, "list units": ask which units the user holds each permission on, then match
// employees by unit in our own data. The cost does not grow with the number of employees.
export async function permissionsByUnits(fga, trace, user, employees, departments, unitTypes) {
  const permissions = new Map(employees.map((e) => [e.id, emptyPermissions()]));
  await Promise.all(
    departments.flatMap((department) =>
      PERMISSIONS.flatMap((permission) =>
        unitTypes.map(async (type) => {
          const { objects } = await trace.run(
            'ListObjects',
            `${type} ${permission} [${department}]`,
            () =>
              fga.listObjects({
                user: `user:${user}`,
                relation: permission,
                type,
                context: departmentContext(department),
              }),
          );
          const units = new Set(objects);
          for (const employee of employees) {
            if (employee.department === department && units.has(employee.unit)) {
              permissions.get(employee.id)[permission] = true;
            }
          }
        }),
      ),
    ),
  );
  return permissions;
}

export async function usersWithPermission(fga, trace, permission, employee) {
  const { users } = await trace.run('ListUsers', `${permission} employee:${employee.id}`, () =>
    fga.listUsers({
      object: { type: 'employee', id: employee.id },
      relation: permission,
      user_filters: [{ type: 'user' }],
      context: departmentContext(employee.department),
    }),
  );
  return users.map((u) => u.object?.id).filter(Boolean).sort();
}

// Reads every stored tuple, following continuation tokens.
export async function readAllTuples(fga, filter = {}) {
  const tuples = [];
  let continuationToken;
  do {
    const page = await fga.read(filter, { pageSize: 100, continuationToken });
    tuples.push(...page.tuples);
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);
  return tuples;
}

function emptyPermissions() {
  return Object.fromEntries(PERMISSIONS.map((p) => [p, false]));
}
