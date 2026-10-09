// Walks the running API through the requirement scenarios and prints what each persona gets.
// Start the server first: npm start
const BASE = process.env.API_URL ?? 'http://localhost:4000';
let failures = 0;

async function call(user, path, options = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-User': user },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

async function visible(user, strategy = 'batch-check') {
  const { body } = await call(user, `/employees?strategy=${strategy}`);
  return body;
}
const ids = (list) => list.employees.map((e) => e.id);
const withSalary = (list) => list.employees.filter((e) => e.salary).map((e) => e.id);

const north = ['e101', 'e102', 'e103', 'e104', 'e105', 'e106', 'e107', 'e108', 'e109', 'e110', 'e111'];

console.log('\n# Lists per persona');
expect('Anita (admin North) sees all 11 North employees', ids(await visible('anita')), north);
expect('Anita sees no salary', withSalary(await visible('anita')), []);
expect('Chitra (salary coordinator North) sees salary for all 11', withSalary(await visible('chitra')), north);
expect('Esha (Rohini + Dwarka) sees those centres and their sub-centres only', ids(await visible('esha')), ['e103', 'e104', 'e105', 'e106', 'e107', 'e108']);
expect('Farhan (Karnataka + Kerala) does not see Tamil Nadu', ids(await visible('farhan')), ['e202', 'e203', 'e204', 'e206']);
expect('Gita (North, HR only) sees only HR employees', ids(await visible('gita')), ['e101', 'e104', 'e108', 'e111']);
expect('Hari sees West finance plus everyone in Pune', ids(await visible('hari')), ['e402', 'e404', 'e405']);
expect('Hari sees salary for finance only', withSalary(await visible('hari')), ['e402', 'e405']);
expect('Jaya (payroll-south group) sees South salaries', withSalary(await visible('jaya')), ['e201', 'e202', 'e203', 'e204', 'e205', 'e206']);
expect('Meera (no grants) sees nobody', ids(await visible('meera')), []);
expect('Indu (coordinator India) sees all 25', ids(await visible('indu')).length, 25);

console.log('\n# The three list strategies agree');
for (const user of ['anita', 'esha', 'gita', 'hari', 'jaya', 'indu']) {
  const [a, b, c] = await Promise.all(['batch-check', 'list-objects', 'list-units'].map((s) => visible(user, s)));
  expect(`${user}: same employees and permissions from all strategies`, [b.employees, c.employees], [a.employees, a.employees]);
  console.log(`      OpenFGA calls: batch-check ${a.trace.fgaCalls}, list-objects ${b.trace.fgaCalls}, list-units ${c.trace.fgaCalls}`);
}

console.log('\n# Single record and edit');
expect('Bala (coordinator) cannot edit', (await call('bala', '/employees/e103', { method: 'PATCH', body: { designation: 'x' } })).status, 403);
expect('Anita (admin) can edit', (await call('anita', '/employees/e103', { method: 'PATCH', body: { designation: 'Centre Manager' } })).status, 200);
expect('Anita gets 404 for a South employee', (await call('anita', '/employees/e202')).status, 404);
expect('Salary is absent from the record Anita gets', (await call('anita', '/employees/e103')).body.employee.salary, null);
expect('Who can see e405 salary', (await call('anita', '/employees/e405/salary-viewers')).body.users, ['hari']);

console.log('\n# Grant, revoke and move take effect on the next request');
const grant = { user: 'user:meera', role: 'coordinator', unit: 'centre:saket' };
await call('anita', '/grants', { method: 'POST', body: grant });
expect('Meera sees Saket after one tuple is written', ids(await visible('meera')), ['e109']);
await call('anita', '/units/move', { method: 'POST', body: { unit: 'centre:saket', parent: 'area:punjab' } });
expect('Deepak (admin Delhi) loses Saket after it moves to Punjab', ids(await visible('deepak')).includes('e109'), false);
expect('Meera keeps Saket, her grant is on the centre', ids(await visible('meera')), ['e109']);
await call('anita', '/units/move', { method: 'POST', body: { unit: 'centre:saket', parent: 'area:delhi' } });
await call('anita', '/grants', { method: 'DELETE', body: grant });
expect('Meera sees nobody after the tuple is deleted', ids(await visible('meera')), []);
expect('Deepak has Saket back', ids(await visible('deepak')).includes('e109'), true);

console.log(failures ? `\n${failures} scenario(s) failed` : '\nAll scenarios passed');
process.exit(failures ? 1 : 0);
