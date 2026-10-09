// HR API for the POC. Every employee endpoint asks OpenFGA before returning or changing data.
// The caller is taken from the X-User header: there is no real login in this POC.
import { fileURLToPath } from 'node:url';
import express from 'express';
import { transformer } from '@openfga/syntax-transformer';
import {
  PERMISSIONS,
  Trace,
  checkEmployee,
  createClient,
  loadStoreConfig,
  permissionsByBatchCheck,
  permissionsByListObjects,
  permissionsByUnits,
  readAllChanges,
  readAllTuples,
  usersWithPermission,
} from './fga.js';
import * as seed from './org.js';

const PORT = process.env.PORT ?? 4000;
const storeConfig = loadStoreConfig();
const fga = createClient(storeConfig);

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
    storeId: storeConfig.storeId,
    employees: employees.map((e) => ({ id: e.id, name: e.name })),
    permissions: PERMISSIONS,
  });
});

app.get('/api/employees', async (req, res) => {
  const strategy = STRATEGIES[req.query.strategy] ? req.query.strategy : 'batch-check';
  const permissions = await STRATEGIES[strategy](req.trace, req.user);
  const visible = employees
    .filter((e) => permissions.get(e.id).can_view_basic)
    .map((e) => present(e, permissions.get(e.id)));
  res.json({
    strategy,
    total: employees.length,
    employees: visible,
    story: await personStory(req.user, visible.length),
    trace: req.trace.summary(),
  });
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
  res.json({ count: tuples.length, tuples: tuples.map((t) => tupleRow(t.key)) });
});

// ---- Explorer: raw views of everything the app and OpenFGA store. Not access controlled. ----

const TREE_RELATIONS = ['country', 'zone', 'area', 'centre'];

// ---- Plain-English wording for tuples, rules and answers, for readers who are not technical. ----

const ROLE_LABEL = { admin: 'Admin', coordinator: 'Coordinator', salary_coordinator: 'Salary coordinator' };
const PERMISSION_LABEL = {
  can_view_basic: 'view basic details',
  can_edit_basic: 'edit basic details',
  can_view_salary: 'view salary',
};
const TYPE_LABEL = { country: 'country', zone: 'zone', area: 'area', centre: 'centre', sub_centre: 'sub-centre' };

const capital = (word) => word[0].toUpperCase() + word.slice(1);
const listText = (items, joiner = 'and') =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`;
const departmentLabel = (code) => (code === 'hr' ? 'HR' : capital(code));

// "centre:rohini" becomes "Rohini (centre)". Zones and the country already say what they are.
function unitText(object) {
  const unit = findUnit(object);
  const type = object.split(':')[0];
  if (!unit) return object;
  return ['country', 'zone'].includes(type) ? unit.name : `${unit.name} (${TYPE_LABEL[type]})`;
}

// "user:anita" becomes "Anita"; "group:payroll-south#member" becomes "Everyone in the payroll-south group".
function whoText(user) {
  const [type, rest] = user.split(':');
  return type === 'group' ? `Everyone in the ${rest.split('#')[0]} group` : capital(rest);
}

function departmentLimit(condition) {
  const departments = condition?.context?.allowed_departments;
  if (!departments?.length) return '';
  return `, for the ${listText(departments.map(departmentLabel))} department${departments.length > 1 ? 's' : ''} only`;
}

function tupleEnglish(key) {
  switch (tupleKind(key.relation)) {
    case 'role grant':
      return `${whoText(key.user)} is ${ROLE_LABEL[key.relation]} of ${unitText(key.object)}${departmentLimit(key.condition)}.`;
    case 'employee placement':
      return `${findEmployee(key.object.split(':')[1])?.name ?? key.object} works at ${unitText(key.user)}.`;
    case 'group membership':
      return `${whoText(key.user)} is a member of the ${key.object.split(':')[1]} group.`;
    default:
      return `${unitText(key.object)} belongs to ${unitText(key.user)}.`;
  }
}

function ruleEnglish({ type, relation, kind, definition }) {
  if (kind === 'role') {
    const parent = definition.match(/ from (\w+)/)?.[1];
    return (
      `${ROLE_LABEL[relation]} of a ${TYPE_LABEL[type]}: anyone given that role on the ${TYPE_LABEL[type]} itself` +
      (parent ? `, plus anyone who is ${ROLE_LABEL[relation]} of the ${TYPE_LABEL[parent]} above it.` : '.')
    );
  }
  if (kind === 'permission') {
    const action = PERMISSION_LABEL[relation];
    if (type === 'employee') {
      return `Whoever may ${action} for an employee's unit may ${action} for that employee.`;
    }
    return `On a ${TYPE_LABEL[type]}, ${listText(definition.split(' or ').map((r) => ROLE_LABEL[r]))} may ${action}.`;
  }
  if (kind === 'membership') return 'A group has members, and each member is a user.';
  if (type === 'employee') return 'Each employee is placed in one unit: a zone, an area, a centre or a sub-centre.';
  return `Each ${TYPE_LABEL[type]} belongs to one ${TYPE_LABEL[relation]}.`;
}

// What a role may and may not do, read from the model's permission rules.
function roleSummary(role, relations) {
  const rules = PERMISSIONS.map((p) => relations.find((r) => r.type === 'zone' && r.relation === p));
  const can = rules.filter((r) => r.definition.split(' or ').includes(role)).map((r) => PERMISSION_LABEL[r.relation]);
  const cannot = rules.filter((r) => !r.definition.split(' or ').includes(role)).map((r) => PERMISSION_LABEL[r.relation]);
  return `${capital(indefinite(ROLE_LABEL[role]))} may ${listText(can)}${cannot.length ? `, but may not ${listText(cannot, 'or')}` : ''}.`;
}

const indefinite = (label) => `${/^([aeiou]|hr\b)/i.test(label) ? 'an' : 'a'} ${label}`;

// The grants that apply to a user, directly or through a group.
function grantsFor(user, tuples) {
  const groups = tuples
    .filter((t) => t.relation === 'member' && t.user === `user:${user}`)
    .map((t) => `${t.object}#member`);
  const grants = tuples.filter(
    (t) => seed.ROLES.includes(t.relation) && (t.user === `user:${user}` || groups.includes(t.user)),
  );
  return { groups, grants };
}

// A short story for the signed-in person: what they hold and what that allows.
async function personStory(user, visibleCount) {
  const [{ relations }, stored] = await Promise.all([currentModel(), readAllTuples(fga)]);
  const tuples = stored.map((t) => t.key);
  const { groups, grants } = grantsFor(user, tuples);
  const name = capital(user);
  if (!grants.length) {
    return [`${name} has not been given any role, so ${name} sees no employees.`];
  }
  const lines = groups.map((g) => `${name} is a member of the ${g.split(':')[1].split('#')[0]} group.`);
  lines.push(...grants.map(tupleEnglish));
  lines.push(...[...new Set(grants.map((g) => g.relation))].map((role) => roleSummary(role, relations)));
  lines.push(
    `A role on a unit also covers every unit below it. Together this lets ${name} see ${visibleCount} of ${employees.length} employees.`,
  );
  return lines;
}

function tupleKind(relation) {
  if (seed.ROLES.includes(relation)) return 'role grant';
  if (relation === 'unit') return 'employee placement';
  if (relation === 'member') return 'group membership';
  return 'tree link';
}

function relationKind(relation) {
  if (relation.startsWith('can_')) return 'permission';
  if (seed.ROLES.includes(relation)) return 'role';
  if (relation === 'member') return 'membership';
  return 'link to parent';
}

// Turns the model DSL into one row per "define" line.
function relationsFromDsl(dsl) {
  const rows = [];
  let type;
  for (const line of dsl.split('\n')) {
    const typeMatch = line.match(/^type (\S+)/);
    const defineMatch = line.match(/^\s+define (\S+): (.+)$/);
    if (typeMatch) type = typeMatch[1];
    if (defineMatch) {
      const [, relation, definition] = defineMatch;
      const row = { type, relation, kind: relationKind(relation), definition };
      rows.push({ in_plain_english: ruleEnglish(row), ...row });
    }
  }
  return rows;
}

async function currentModel() {
  const { authorization_models: models } = await fga.readAuthorizationModels();
  const model = models.find((m) => m.id === storeConfig.modelId) ?? models[0];
  const dsl = transformer.transformJSONToDSL(model);
  return { models, model, dsl, relations: relationsFromDsl(dsl) };
}

const conditionText = (condition) =>
  condition ? `${condition.name} ${JSON.stringify(condition.context ?? {})}` : '';

const shortTime = (timestamp) => timestamp.slice(0, 19).replace('T', ' ');

// One tuple in OpenFGA's own form (user, relation, object, condition), plus a sentence.
function tupleRow(key, extra = {}) {
  return {
    in_plain_english: tupleEnglish(key),
    kind: tupleKind(key.relation),
    user: key.user,
    relation: key.relation,
    object: key.object,
    condition: conditionText(key.condition),
    ...extra,
  };
}

// Everything the HR application itself holds. In a real system this is the HR database.
app.get('/api/explorer/hr', (req, res) => {
  res.json({
    employees: employees.map(({ salary, ...e }) => ({
      in_plain_english: `${e.name} is ${indefinite(e.designation)} in ${departmentLabel(e.department)}, working at ${unitText(e.unit)}.`,
      ...e,
      annual_ctc: salary.annualCtc,
      bank_account: salary.bankAccount,
    })),
    units: units.map((u) => ({
      in_plain_english: u.parent
        ? `${u.name} is ${indefinite(TYPE_LABEL[u.type])} inside ${unitText(u.parent)}.`
        : `${u.name} is the top of the organisation.`,
      object: seed.objectId(u),
      type: u.type,
      id: u.id,
      name: u.name,
      parent: u.parent ?? '',
      employees: employees.filter((e) => e.unit === seed.objectId(u)).length,
    })),
    departments: seed.DEPARTMENTS.map((code) => ({
      code,
      employees: employees.filter((e) => e.department === code).length,
    })),
    users: seed.personas.map((p) => ({ id: p.id, object: `user:${p.id}`, description: p.label })),
  });
});

// Everything OpenFGA holds for this store, read through its API.
app.get('/api/explorer/fga', async (req, res) => {
  const [store, { models, model, dsl, relations }, tuples, changes] = await Promise.all([
    fga.getStore(),
    currentModel(),
    readAllTuples(fga),
    readAllChanges(fga),
  ]);
  res.json({
    store: [{ id: store.id, name: store.name, created_at: store.created_at, updated_at: store.updated_at }],
    models: models.map((m) => ({
      id: m.id,
      schema_version: m.schema_version,
      types: m.type_definitions.length,
      conditions: Object.keys(m.conditions ?? {}).join(', '),
      in_use: m.id === model.id ? 'yes' : '',
    })),
    dsl,
    relations,
    tuples: tuples.map((t) => tupleRow(t.key, { written_at: shortTime(t.timestamp) })),
    changes: changes.map((c, index) => ({
      '#': index + 1,
      ...tupleRow(c.tuple_key),
      in_plain_english: `${c.operation === 'TUPLE_OPERATION_WRITE' ? 'Added' : 'Removed'}: ${tupleEnglish(c.tuple_key)}`,
      operation: c.operation === 'TUPLE_OPERATION_WRITE' ? 'write' : 'delete',
      at: shortTime(c.timestamp),
    })),
  });
});

// Asks OpenFGA for the answer, then lists the stored tuples that lead to it.
// The path is rebuilt by the app from the tuples; OpenFGA itself returns only allowed or not.
app.get('/api/explain', async (req, res) => {
  const { user, permission } = req.query;
  const employee = findEmployee(req.query.employee);
  if (!user || !employee || !PERMISSIONS.includes(permission)) {
    return res.status(400).json({ error: 'user, permission and employee are required' });
  }
  const allowed = await checkEmployee(fga, req.trace, user, permission, employee);
  const [{ relations }, stored] = await Promise.all([currentModel(), readAllTuples(fga)]);
  const tuples = stored.map((t) => t.key);
  const text = (t) => `${t.user} is ${t.relation} of ${t.object}`;

  // "can_view_basic: admin or coordinator or salary_coordinator" on a unit type lists the roles.
  const roles = relations
    .find((r) => r.type === 'zone' && r.relation === permission)
    .definition.split(' or ');
  const groups = tuples
    .filter((t) => t.relation === 'member' && t.user === `user:${user}`)
    .map((t) => `${t.object}#member`);

  const steps = [];
  let link = tuples.find((t) => t.object === `employee:${employee.id}` && t.relation === 'unit');
  while (link) {
    const unit = link.user;
    const grants = tuples
      .filter((t) => t.object === unit && seed.ROLES.includes(t.relation))
      .filter((t) => t.user === `user:${user}` || groups.includes(t.user))
      .map((t) => {
        const givesPermission = roles.includes(t.relation);
        const departments = t.condition?.context?.allowed_departments;
        const departmentOk = !departments || departments.includes(employee.department);
        return {
          tuple: text(t),
          via: t.user.startsWith('group:') ? `member of the ${t.user.split(':')[1].split('#')[0]} group` : 'direct grant',
          role: t.relation,
          givesPermission,
          departments: departments ?? [],
          departmentOk,
          counts: givesPermission && departmentOk,
        };
      });
    steps.push({ unit, unitPath: unitPath(unit), reachedBy: text(link), grants });
    link = tuples.find((t) => t.object === unit && TREE_RELATIONS.includes(t.relation));
  }

  // The same answer as a short story in plain English.
  const name = capital(user);
  const action = PERMISSION_LABEL[permission];
  const winning = steps.findIndex((s) => s.grants.some((g) => g.counts));
  const walked = steps.slice(0, winning < 0 ? steps.length : winning + 1).map((s) => unitText(s.unit));
  const story = [
    `${employee.name} works at ${walked[0]}` +
      walked.slice(1).map((u) => `, which is part of ${u}`).join('') + '.',
  ];
  if (winning >= 0) {
    const grant = steps[winning].grants.find((g) => g.counts);
    const unit = unitText(steps[winning].unit);
    story.push(
      grant.via === 'direct grant'
        ? `${name} is ${ROLE_LABEL[grant.role]} of ${unit}.`
        : `${name} is a ${grant.via}, and everyone in that group is ${ROLE_LABEL[grant.role]} of ${unit}.`,
      `${capital(indefinite(ROLE_LABEL[grant.role]))} may ${action}, and a role on a unit covers everything below it.`,
      `So yes, ${name} may ${action} for ${employee.name}.`,
    );
  } else {
    const misses = steps.flatMap((s) => s.grants.map((g) => ({ ...g, unit: unitText(s.unit) })));
    for (const miss of misses) {
      const why = [];
      if (!miss.givesPermission) why.push(`${indefinite(ROLE_LABEL[miss.role])} may not ${action}`);
      if (!miss.departmentOk) {
        why.push(
          `that role is limited to ${listText(miss.departments.map(departmentLabel))} and ${employee.name} is in ${departmentLabel(employee.department)}`,
        );
      }
      story.push(`${name} is ${ROLE_LABEL[miss.role]} of ${miss.unit}, but ${listText(why)}.`);
    }
    if (!misses.length) story.push(`${name} has not been given any role on ${listText(walked, 'or')}.`);
    story.push(`So no, ${name} may not ${action} for ${employee.name}.`);
  }

  res.json({
    allowed,
    story,
    question: `Can user:${user} ${permission} employee:${employee.id}?`,
    employee: { id: employee.id, name: employee.name, department: employee.department },
    rolesThatGivePermission: roles,
    groups,
    steps,
    explained: steps.some((s) => s.grants.some((g) => g.counts)),
    trace: req.trace.summary(),
  });
});

app.use((err, req, res, next) => {
  const message = err.responseData?.message ?? err.message;
  console.error(message);
  res.status(err.statusCode === 400 ? 400 : 500).json({ error: message });
});

app.listen(PORT, () => console.log(`HR API and UI on http://localhost:${PORT}`));
