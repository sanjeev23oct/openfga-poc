// HR API for the POC. Every employee endpoint asks OpenFGA before returning or changing data.
// The caller is taken from the X-User header: there is no real login in this POC.
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  PERMISSIONS,
  Trace,
  checkEmployee,
  createClient,
  permissionsByBatchCheck,
  permissionsByListObjects,
  permissionsByUnits,
  readAllTuples,
  usersWithPermission,
} from './fga.js';
import * as seed from './org.js';

const PORT = process.env.PORT ?? 4000;
const fga = createClient();

// In-memory copy of the HR data, so edits and moves last until the server restarts.
const units = structuredClone(seed.units);
const employees = structuredClone(seed.employees);

const STRATEGIES = {
  'batch-check': (trace, user) => permissionsByBatchCheck(fga, trace, user, employees),
  'list-objects': (trace, user) =>
    permissionsByListObjects(fga, trace, user, employees, seed.DEPARTMENTS),
  'list-units': (trace, user) =>
    permissionsByUnits(
      fga,
      trace,
      user,
      employees,
      seed.DEPARTMENTS,
      seed.UNIT_TYPES.filter((t) => t !== 'country'),
    ),
};

const findUnit = (object) => units.find((u) => seed.objectId(u) === object);
const findEmployee = (id) => employees.find((e) => e.id === id);

function unitPath(object) {
  const names = [];
  for (let unit = findUnit(object); unit; unit = findUnit(unit.parent)) names.unshift(unit.name);
  return names.join(' / ');
}

// Salary leaves the server only when can_view_salary is true.
function present(employee, permissions) {
  const { salary, ...basic } = employee;
  return {
    ...basic,
    unitPath: unitPath(employee.unit),
    salary: permissions.can_view_salary ? salary : null,
    permissions,
  };
}

const app = express();
app.use(express.json());
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

app.use('/api', (req, res, next) => {
  req.user = req.get('X-User');
  if (!req.user) return res.status(401).json({ error: 'Send the X-User header' });
  req.trace = new Trace();
  next();
});

app.get('/api/meta', (req, res) => {
  res.json({
    personas: seed.personas,
    departments: seed.DEPARTMENTS,
    roles: seed.ROLES,
    strategies: Object.keys(STRATEGIES),
    units: units.map((u) => ({ object: seed.objectId(u), type: u.type, parent: u.parent, path: unitPath(seed.objectId(u)) })),
    storeId: fga.storeId,
  });
});

app.get('/api/employees', async (req, res) => {
  const strategy = STRATEGIES[req.query.strategy] ? req.query.strategy : 'batch-check';
  const permissions = await STRATEGIES[strategy](req.trace, req.user);
  const visible = employees
    .filter((e) => permissions.get(e.id).can_view_basic)
    .map((e) => present(e, permissions.get(e.id)));
  res.json({ strategy, total: employees.length, employees: visible, trace: req.trace.summary() });
});

app.get('/api/employees/:id', async (req, res) => {
  const employee = findEmployee(req.params.id);
  // Unknown and forbidden look the same, so ids cannot be probed.
  if (!employee || !(await checkEmployee(fga, req.trace, req.user, 'can_view_basic', employee))) {
    return res.status(404).json({ error: 'Not found', trace: req.trace.summary() });
  }
  const permissions = { can_view_basic: true };
  for (const permission of PERMISSIONS.slice(1)) {
    permissions[permission] = await checkEmployee(fga, req.trace, req.user, permission, employee);
  }
  res.json({ employee: present(employee, permissions), trace: req.trace.summary() });
});

app.patch('/api/employees/:id', async (req, res) => {
  const employee = findEmployee(req.params.id);
  if (!employee || !(await checkEmployee(fga, req.trace, req.user, 'can_edit_basic', employee))) {
    return res.status(403).json({ error: 'You cannot edit this employee', trace: req.trace.summary() });
  }
  if (typeof req.body.designation === 'string' && req.body.designation.trim()) {
    employee.designation = req.body.designation.trim();
  }
  res.json({ ok: true, trace: req.trace.summary() });
});

// Audit view: who can see this employee's salary. Not access controlled in the POC.
app.get('/api/employees/:id/salary-viewers', async (req, res) => {
  const employee = findEmployee(req.params.id);
  if (!employee) return res.status(404).json({ error: 'Not found' });
  const users = await usersWithPermission(fga, req.trace, 'can_view_salary', employee);
  res.json({ users, trace: req.trace.summary() });
});

// Grant management. Not access controlled in the POC: any persona can change grants.
app.get('/api/grants', async (req, res) => {
  const tuples = await readAllTuples(fga);
  const grants = tuples
    .map((t) => t.key)
    .filter((k) => seed.ROLES.includes(k.relation))
    .map((k) => ({
      user: k.user,
      role: k.relation,
      unit: k.object,
      unitPath: unitPath(k.object),
      departments: k.condition?.context?.allowed_departments ?? [],
    }));
  res.json({ grants });
});

app.post('/api/grants', async (req, res) => {
  const { user, role, unit, departments = [] } = req.body;
  if (!user || !seed.ROLES.includes(role) || !findUnit(unit)) {
    return res.status(400).json({ error: 'user, role and unit are required' });
  }
  const subject = user.includes(':') ? user : `user:${user}`;
  await fga.write({ writes: [seed.grantTuple({ user: subject, role, unit, departments })] });
  res.json({ ok: true });
});

app.delete('/api/grants', async (req, res) => {
  const { user, role, unit } = req.body;
  await fga.write({ deletes: [{ user, relation: role, object: unit }] });
  res.json({ ok: true });
});

// Moves a unit under another parent of the same type: one tuple deleted, one written.
app.post('/api/units/move', async (req, res) => {
  const unit = findUnit(req.body.unit);
  const newParent = findUnit(req.body.parent);
  if (!unit?.parent || !newParent || newParent.type !== unit.parent.split(':')[0]) {
    return res.status(400).json({ error: 'parent must be an existing unit of the same type as the current parent' });
  }
  const before = seed.parentTuple(unit);
  unit.parent = req.body.parent;
  await fga.write({ deletes: [before], writes: [seed.parentTuple(unit)] });
  res.json({ ok: true, path: unitPath(req.body.unit) });
});

app.get('/api/tuples', async (req, res) => {
  const tuples = await readAllTuples(fga);
  res.json({ count: tuples.length, tuples: tuples.map((t) => t.key) });
});

app.use((err, req, res, next) => {
  const message = err.responseData?.message ?? err.message;
  console.error(message);
  res.status(err.statusCode === 400 ? 400 : 500).json({ error: message });
});

app.listen(PORT, () => console.log(`HR API and UI on http://localhost:${PORT}`));
