// Runs one filtered, sorted, paged employee list and one report four different ways, and counts
// what each way costs. Three ways use OpenFGA for access; the fourth uses SQL tables only.
//
// Employee data sits in an in-memory SQLite database that stands in for the HR database.
// For the SQL-only way, the grants and the tree are copied from OpenFGA into SQL tables first.
import { DatabaseSync } from 'node:sqlite';

const UNIT_TYPES = ['zone', 'area', 'centre', 'sub_centre'];
const TREE_RELATIONS = ['country', 'zone', 'area', 'centre'];
const SORTABLE = ['name', 'id', 'department', 'designation'];
const VIEW = 'can_view_basic';

// employees: HR rows. tuples: every OpenFGA tuple key. rolePermissions: [{ role, permission }].
export function buildDatabase({ employees, tuples, roles, rolePermissions }) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE employee (id TEXT PRIMARY KEY, name TEXT, department TEXT, unit TEXT, designation TEXT);
    -- The tables below exist only for the SQL-only way. They hold what OpenFGA holds as tuples.
    CREATE TABLE unit_closure (ancestor TEXT, descendant TEXT, PRIMARY KEY (ancestor, descendant));
    CREATE TABLE role_grant (id INTEGER PRIMARY KEY, subject TEXT, role TEXT, unit TEXT);
    CREATE TABLE grant_department (grant_id INTEGER, department TEXT);
    CREATE TABLE group_member (group_ref TEXT, user_id TEXT);
    CREATE TABLE role_permission (role TEXT, permission TEXT);
  `);

  const insertEmployee = db.prepare('INSERT INTO employee VALUES (?, ?, ?, ?, ?)');
  for (const e of employees) insertEmployee.run(e.id, e.name, e.department, e.unit, e.designation);

  // Every unit paired with itself and with each unit above it.
  const parentOf = new Map(
    tuples.filter((t) => TREE_RELATIONS.includes(t.relation)).map((t) => [t.object, t.user]),
  );
  const insertClosure = db.prepare('INSERT OR IGNORE INTO unit_closure VALUES (?, ?)');
  for (const unit of new Set([...parentOf.keys(), ...parentOf.values()])) {
    for (let ancestor = unit; ancestor; ancestor = parentOf.get(ancestor)) insertClosure.run(ancestor, unit);
  }

  const insertGrant = db.prepare('INSERT INTO role_grant (subject, role, unit) VALUES (?, ?, ?)');
  const insertGrantDepartment = db.prepare('INSERT INTO grant_department VALUES (?, ?)');
  for (const t of tuples.filter((t) => roles.includes(t.relation))) {
    const { lastInsertRowid } = insertGrant.run(t.user, t.relation, t.object);
    for (const department of t.condition?.context?.allowed_departments ?? []) {
      insertGrantDepartment.run(lastInsertRowid, department);
    }
  }

  const insertMember = db.prepare('INSERT INTO group_member VALUES (?, ?)');
  for (const t of tuples.filter((t) => t.relation === 'member')) {
    insertMember.run(`${t.object}#member`, t.user.split(':')[1]);
  }

  const insertRolePermission = db.prepare('INSERT INTO role_permission VALUES (?, ?)');
  for (const { role, permission } of rolePermissions) insertRolePermission.run(role, permission);

  return db;
}

// Counts what one way of answering the request costs.
class Meter {
  dbQueries = 0;
  dbRows = 0;
  employeeRows = 0;
  fgaCalls = 0;
  fgaChecks = 0;
  sql = [];
  steps = [];

  constructor(db, fga) {
    this.db = db;
    this.fga = fga;
    this.started = performance.now();
  }

  query(sql, params = []) {
    const rows = this.db.prepare(sql).all(...params);
    this.dbQueries += 1;
    this.dbRows += rows.length;
    if (sql.startsWith('SELECT e.*')) this.employeeRows += rows.length;
    this.sql.push(sql.replace(/\s+/g, ' ').trim());
    return rows;
  }

  async batchCheck(user, rows) {
    if (!rows.length) return [];
    const { result } = await this.fga.batchCheck({
      checks: rows.map((row, index) => ({
        user: `user:${user}`,
        relation: VIEW,
        object: `employee:${row.id}`,
        context: { employee_department: row.department },
        correlationId: String(index),
      })),
    });
    // The server takes at most 50 checks per request; the SDK splits larger batches.
    this.fgaCalls += Math.ceil(rows.length / 50);
    this.fgaChecks += rows.length;
    return rows.filter((_, index) => result.find((r) => r.correlationId === String(index))?.allowed);
  }

  async listUnits(user, department) {
    const lists = await Promise.all(
      UNIT_TYPES.map((type) =>
        this.fga.listObjects({
          user: `user:${user}`,
          relation: VIEW,
          type,
          context: { employee_department: department },
        }),
      ),
    );
    this.fgaCalls += UNIT_TYPES.length;
    return lists.flatMap((l) => l.objects);
  }

  step(where, text, count) {
    this.steps.push({ where, text, count });
  }

  metrics() {
    return {
      dbQueries: this.dbQueries,
      dbRows: this.dbRows,
      employeeRows: this.employeeRows,
      fgaCalls: this.fgaCalls,
      fgaChecks: this.fgaChecks,
      ms: Math.round((performance.now() - this.started) * 10) / 10,
    };
  }
}

function filterClause({ department, search }) {
  const parts = [];
  const params = [];
  if (department) {
    parts.push('e.department = ?');
    params.push(department);
  }
  if (search) {
    parts.push('(e.name LIKE ? OR e.designation LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  return { where: parts.length ? parts.join(' AND ') : '1 = 1', params };
}

const headcount = (rows) => {
  const counts = new Map();
  for (const row of rows) counts.set(row.department, (counts.get(row.department) ?? 0) + 1);
  return [...counts].map(([department, employees]) => ({ department, employees })).sort((a, b) => a.department.localeCompare(b.department));
};

// 1. Page first, then check. Quick, but the page comes back short and the totals are wrong.
async function pageThenCheck(meter, user, request) {
  const { where, params } = filterClause(request);
  const pageRows = meter.query(
    `SELECT e.* FROM employee e WHERE ${where} ORDER BY e.${request.sort} LIMIT ? OFFSET ?`,
    [...params, request.pageSize, request.offset],
  );
  meter.step('database', 'Filter, sort and take one page, ignoring access', pageRows.length);
  const [{ total }] = meter.query(`SELECT COUNT(*) AS total FROM employee e WHERE ${where}`, params);
  const report = meter.query(
    `SELECT e.department, COUNT(*) AS employees FROM employee e WHERE ${where} GROUP BY e.department ORDER BY e.department`,
    params,
  );
  meter.step('database', 'Count and report, ignoring access', total);
  const allowed = await meter.batchCheck(user, pageRows);
  meter.step('openfga', 'Check each row on the page', pageRows.length);
  meter.step('application', 'Rows left after removing the denied ones', allowed.length);
  return { page: allowed, total, report };
}

// 2. Pull everything that matches, check all of it, then page in the application.
async function pullAllThenCheck(meter, user, request) {
  const { where, params } = filterClause(request);
  const rows = meter.query(`SELECT e.* FROM employee e WHERE ${where} ORDER BY e.${request.sort}`, params);
  meter.step('database', 'Filter and sort, then return every matching row', rows.length);
  const allowed = await meter.batchCheck(user, rows);
  meter.step('openfga', 'Check every one of those rows', rows.length);
  meter.step('application', 'Keep the allowed rows', allowed.length);
  const page = allowed.slice(request.offset, request.offset + request.pageSize);
  meter.step('application', 'Cut out the page, count, and build the report', page.length);
  return { page, total: allowed.length, report: headcount(allowed) };
}

// 3. Ask OpenFGA which units the user may see, then let the database do everything else.
async function unitsThenQuery(meter, user, request, departments) {
  const wanted = request.department ? [request.department] : departments;
  const perDepartment = await Promise.all(
    wanted.map(async (department) => ({ department, units: await meter.listUnits(user, department) })),
  );
  const unitCount = new Set(perDepartment.flatMap((d) => d.units)).size;
  meter.step('openfga', 'List the units this user may see', unitCount);

  const usable = perDepartment.filter((d) => d.units.length);
  const access = usable.length
    ? usable.map((d) => `(e.department = ? AND e.unit IN (${d.units.map(() => '?').join(', ')}))`).join(' OR ')
    : '1 = 0';
  const accessParams = usable.flatMap((d) => [d.department, ...d.units]);
  const { where, params } = filterClause(request);
  const all = [...accessParams, ...params];

  const page = meter.query(
    `SELECT e.* FROM employee e WHERE (${access}) AND ${where} ORDER BY e.${request.sort} LIMIT ? OFFSET ?`,
    [...all, request.pageSize, request.offset],
  );
  meter.step('database', 'Filter by those units and the user\'s filters, sort, take one page', page.length);
  const [{ total }] = meter.query(`SELECT COUNT(*) AS total FROM employee e WHERE (${access}) AND ${where}`, all);
  const report = meter.query(
    `SELECT e.department, COUNT(*) AS employees FROM employee e WHERE (${access}) AND ${where} GROUP BY e.department ORDER BY e.department`,
    all,
  );
  meter.step('database', 'Count and report with the same unit filter', total);
  return { page, total, report };
}

// 4. No OpenFGA. Access is a clause in the SQL, joined against grant tables.
const SQL_ACCESS = `EXISTS (
  SELECT 1
  FROM unit_closure c
  JOIN role_grant g ON g.unit = c.ancestor
  JOIN role_permission p ON p.role = g.role
  WHERE c.descendant = e.unit
    AND p.permission = '${VIEW}'
    AND (g.subject = ? OR g.subject IN (SELECT group_ref FROM group_member WHERE user_id = ?))
    AND (NOT EXISTS (SELECT 1 FROM grant_department d WHERE d.grant_id = g.id)
         OR EXISTS (SELECT 1 FROM grant_department d WHERE d.grant_id = g.id AND d.department = e.department))
)`;

async function sqlOnly(meter, user, request) {
  const { where, params } = filterClause(request);
  const all = [`user:${user}`, user, ...params];
  const page = meter.query(
    `SELECT e.* FROM employee e WHERE ${SQL_ACCESS} AND ${where} ORDER BY e.${request.sort} LIMIT ? OFFSET ?`,
    [...all, request.pageSize, request.offset],
  );
  meter.step('database', 'One query: access, filters, sort and page together', page.length);
  const [{ total }] = meter.query(`SELECT COUNT(*) AS total FROM employee e WHERE ${SQL_ACCESS} AND ${where}`, all);
  const report = meter.query(
    `SELECT e.department, COUNT(*) AS employees FROM employee e WHERE ${SQL_ACCESS} AND ${where} GROUP BY e.department ORDER BY e.department`,
    all,
  );
  meter.step('database', 'Count and report with the same access clause', total);
  return { page, total, report };
}

const APPROACHES = [
  {
    key: 'page-then-check',
    title: 'Page first, then check',
    engine: 'OpenFGA',
    idea: 'The database returns one page without knowing about access. OpenFGA then removes rows the user may not see.',
    run: pageThenCheck,
  },
  {
    key: 'pull-all-then-check',
    title: 'Pull everything, then check',
    engine: 'OpenFGA',
    idea: 'The database returns every row that matches the filters. OpenFGA checks all of them, and the application pages what is left.',
    run: pullAllThenCheck,
  },
  {
    key: 'units-then-query',
    title: 'Ask for units first, then query',
    engine: 'OpenFGA',
    idea: 'OpenFGA says which units the user may see. The database then filters, sorts, pages and totals using those units.',
    run: unitsThenQuery,
  },
  {
    key: 'sql-only',
    title: 'SQL tables only',
    engine: 'No OpenFGA',
    idea: 'Grants and the tree are SQL tables. Access is one more clause in the same query as the filters.',
    run: sqlOnly,
  },
];

export async function compareApproaches({ db, fga, user, departments, request, employeeCount }) {
  const clean = {
    department: departments.includes(request.department) ? request.department : '',
    search: String(request.search ?? '').trim().slice(0, 40),
    sort: SORTABLE.includes(request.sort) ? request.sort : 'name',
    pageSize: Math.min(Math.max(Number(request.pageSize) || 5, 1), 25),
    page: Math.max(Number(request.page) || 1, 1),
  };
  clean.offset = (clean.page - 1) * clean.pageSize;

  const results = [];
  for (const approach of APPROACHES) {
    const meter = new Meter(db, fga);
    const outcome = await approach.run(meter, user, clean, departments);
    results.push({
      key: approach.key,
      title: approach.title,
      engine: approach.engine,
      idea: approach.idea,
      ...outcome,
      steps: meter.steps,
      sql: meter.sql,
      metrics: meter.metrics(),
    });
  }

  // "Pull everything, then check" asks OpenFGA about every row, so it is the reference answer.
  const truth = results.find((r) => r.key === 'pull-all-then-check');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const scale = 10000 / employeeCount;
  for (const result of results) {
    result.pageCorrect = same(result.page.map((r) => r.id), truth.page.map((r) => r.id));
    result.totalCorrect = result.total === truth.total;
    result.reportCorrect = same(result.report, truth.report);
    // Rough projection: work that depends on the number of matching rows grows with the company.
    const grows = result.key === 'pull-all-then-check';
    result.atTenThousand = {
      employeeRows: grows ? Math.round(result.metrics.employeeRows * scale) : result.metrics.employeeRows,
      fgaChecks: grows ? Math.round(result.metrics.fgaChecks * scale) : result.metrics.fgaChecks,
    };
  }
  return { request: clean, sortable: SORTABLE, results };
}
