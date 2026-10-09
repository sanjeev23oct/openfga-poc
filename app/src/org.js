// Seed data for the POC. This file stands in for the HR database:
// the org tree, the employees and who has been granted which role.
// tuplesFromSeed() turns the parts OpenFGA needs into relationship tuples.

export const DEPARTMENTS = ['hr', 'finance', 'operations', 'sales'];
export const ROLES = ['admin', 'coordinator', 'salary_coordinator'];
export const UNIT_TYPES = ['country', 'zone', 'area', 'centre', 'sub_centre'];

// parent is the full object id of the unit above, e.g. "zone:north".
export const units = [
  { type: 'country', id: 'india', name: 'India' },

  { type: 'zone', id: 'north', name: 'North Zone', parent: 'country:india' },
  { type: 'zone', id: 'south', name: 'South Zone', parent: 'country:india' },
  { type: 'zone', id: 'east', name: 'East Zone', parent: 'country:india' },
  { type: 'zone', id: 'west', name: 'West Zone', parent: 'country:india' },

  { type: 'area', id: 'delhi', name: 'Delhi', parent: 'zone:north' },
  { type: 'area', id: 'punjab', name: 'Punjab', parent: 'zone:north' },
  { type: 'area', id: 'karnataka', name: 'Karnataka', parent: 'zone:south' },
  { type: 'area', id: 'tamil-nadu', name: 'Tamil Nadu', parent: 'zone:south' },
  { type: 'area', id: 'kerala', name: 'Kerala', parent: 'zone:south' },
  { type: 'area', id: 'west-bengal', name: 'West Bengal', parent: 'zone:east' },
  { type: 'area', id: 'maharashtra', name: 'Maharashtra', parent: 'zone:west' },
  { type: 'area', id: 'gujarat', name: 'Gujarat', parent: 'zone:west' },

  { type: 'centre', id: 'rohini', name: 'Rohini', parent: 'area:delhi' },
  { type: 'centre', id: 'dwarka', name: 'Dwarka', parent: 'area:delhi' },
  { type: 'centre', id: 'saket', name: 'Saket', parent: 'area:delhi' },
  { type: 'centre', id: 'ludhiana', name: 'Ludhiana', parent: 'area:punjab' },
  { type: 'centre', id: 'bengaluru', name: 'Bengaluru', parent: 'area:karnataka' },
  { type: 'centre', id: 'mysuru', name: 'Mysuru', parent: 'area:karnataka' },
  { type: 'centre', id: 'chennai', name: 'Chennai', parent: 'area:tamil-nadu' },
  { type: 'centre', id: 'kochi', name: 'Kochi', parent: 'area:kerala' },
  { type: 'centre', id: 'kolkata', name: 'Kolkata', parent: 'area:west-bengal' },
  { type: 'centre', id: 'mumbai', name: 'Mumbai', parent: 'area:maharashtra' },
  { type: 'centre', id: 'pune', name: 'Pune', parent: 'area:maharashtra' },
  { type: 'centre', id: 'ahmedabad', name: 'Ahmedabad', parent: 'area:gujarat' },

  { type: 'sub_centre', id: 'rohini-sector-7', name: 'Rohini Sector 7', parent: 'centre:rohini' },
  { type: 'sub_centre', id: 'rohini-sector-13', name: 'Rohini Sector 13', parent: 'centre:rohini' },
  { type: 'sub_centre', id: 'andheri', name: 'Andheri', parent: 'centre:mumbai' },
];

const emp = (id, name, department, unit, designation, ctc) => ({
  id,
  name,
  department,
  unit,
  designation,
  email: `${name.toLowerCase().replace(/ /g, '.')}@example.in`,
  salary: { annualCtc: ctc, bankAccount: `XXXX${id.slice(1)}7${id.slice(-1)}` },
});

export const employees = [
  emp('e101', 'Aarav Mehta', 'hr', 'zone:north', 'Zonal HR Head', 3200000),
  emp('e102', 'Bhavna Kapoor', 'finance', 'area:delhi', 'Area Finance Lead', 2100000),
  emp('e103', 'Chirag Sethi', 'operations', 'centre:rohini', 'Centre Manager', 1500000),
  emp('e104', 'Divya Anand', 'hr', 'centre:rohini', 'HR Executive', 800000),
  emp('e105', 'Eklavya Rana', 'sales', 'sub_centre:rohini-sector-7', 'Sales Associate', 550000),
  emp('e106', 'Falguni Bhatt', 'operations', 'sub_centre:rohini-sector-13', 'Operations Associate', 520000),
  emp('e107', 'Gaurav Tyagi', 'sales', 'centre:dwarka', 'Sales Lead', 1100000),
  emp('e108', 'Harleen Sodhi', 'hr', 'centre:dwarka', 'HR Executive', 780000),
  emp('e109', 'Ishaan Malik', 'finance', 'centre:saket', 'Accountant', 900000),
  emp('e110', 'Jasleen Gill', 'operations', 'centre:ludhiana', 'Centre Manager', 1400000),
  emp('e111', 'Kabir Sandhu', 'hr', 'area:punjab', 'Area HR Lead', 1900000),

  emp('e201', 'Lakshmi Iyer', 'finance', 'zone:south', 'Zonal Finance Head', 3400000),
  emp('e202', 'Manoj Gowda', 'operations', 'centre:bengaluru', 'Centre Manager', 1600000),
  emp('e203', 'Nandini Rao', 'sales', 'centre:bengaluru', 'Sales Lead', 1200000),
  emp('e204', 'Omkar Shetty', 'hr', 'centre:mysuru', 'HR Executive', 760000),
  emp('e205', 'Priya Raman', 'finance', 'centre:chennai', 'Accountant', 950000),
  emp('e206', 'Rahul Menon', 'operations', 'centre:kochi', 'Centre Manager', 1450000),

  emp('e301', 'Sohini Ghosh', 'operations', 'centre:kolkata', 'Centre Manager', 1500000),
  emp('e302', 'Tapan Dutta', 'finance', 'area:west-bengal', 'Area Finance Lead', 2000000),

  emp('e401', 'Urmila Patil', 'hr', 'zone:west', 'Zonal HR Head', 3100000),
  emp('e402', 'Varun Deshmukh', 'finance', 'centre:mumbai', 'Accountant', 1000000),
  emp('e403', 'Waheeda Shaikh', 'sales', 'sub_centre:andheri', 'Sales Associate', 600000),
  emp('e404', 'Yash Kulkarni', 'operations', 'centre:pune', 'Centre Manager', 1550000),
  emp('e405', 'Zoya Joshi', 'finance', 'centre:pune', 'Accountant', 920000),
  emp('e406', 'Ankit Shah', 'sales', 'centre:ahmedabad', 'Sales Lead', 1150000),
];

export const groups = [{ id: 'payroll-south', members: ['jaya', 'kiran'] }];

// One entry per grant. `departments` limits the grant to those departments.
export const grants = [
  { user: 'user:indu', role: 'coordinator', unit: 'country:india' },
  { user: 'user:anita', role: 'admin', unit: 'zone:north' },
  { user: 'user:bala', role: 'coordinator', unit: 'zone:north' },
  { user: 'user:chitra', role: 'salary_coordinator', unit: 'zone:north' },
  { user: 'user:deepak', role: 'admin', unit: 'area:delhi' },
  { user: 'user:esha', role: 'coordinator', unit: 'centre:rohini' },
  { user: 'user:esha', role: 'coordinator', unit: 'centre:dwarka' },
  { user: 'user:farhan', role: 'admin', unit: 'area:karnataka' },
  { user: 'user:farhan', role: 'admin', unit: 'area:kerala' },
  { user: 'user:gita', role: 'coordinator', unit: 'zone:north', departments: ['hr'] },
  { user: 'user:hari', role: 'salary_coordinator', unit: 'zone:west', departments: ['finance'] },
  { user: 'user:hari', role: 'admin', unit: 'centre:pune' },
  { user: 'group:payroll-south#member', role: 'salary_coordinator', unit: 'zone:south' },
  { user: 'user:lata', role: 'admin', unit: 'sub_centre:rohini-sector-7' },
];

// Who each demo login is, shown in the UI.
export const personas = [
  { id: 'indu', label: 'Indu: coordinator, all India' },
  { id: 'anita', label: 'Anita: admin, North zone' },
  { id: 'bala', label: 'Bala: coordinator, North zone' },
  { id: 'chitra', label: 'Chitra: salary coordinator, North zone' },
  { id: 'deepak', label: 'Deepak: admin, Delhi area' },
  { id: 'esha', label: 'Esha: coordinator, Rohini and Dwarka centres only' },
  { id: 'farhan', label: 'Farhan: admin, Karnataka and Kerala areas only' },
  { id: 'gita', label: 'Gita: coordinator, North zone, HR department only' },
  { id: 'hari', label: 'Hari: salary coordinator West (Finance only) and admin Pune' },
  { id: 'jaya', label: 'Jaya: member of payroll-south group' },
  { id: 'lata', label: 'Lata: admin, Rohini Sector 7 sub-centre' },
  { id: 'meera', label: 'Meera: no grants' },
];

export const objectId = (unit) => `${unit.type}:${unit.id}`;

export function grantTuple({ user, role, unit, departments }) {
  const tuple = { user, relation: role, object: unit };
  if (departments?.length) {
    tuple.condition = { name: 'in_department', context: { allowed_departments: departments } };
  }
  return tuple;
}

// The relation from a child unit to its parent is named after the parent's type.
export function parentTuple(unit) {
  return { user: unit.parent, relation: unit.parent.split(':')[0], object: objectId(unit) };
}

export function employeeTuple(employee) {
  return { user: employee.unit, relation: 'unit', object: `employee:${employee.id}` };
}

export function tuplesFromSeed() {
  return [
    ...units.filter((u) => u.parent).map(parentTuple),
    ...groups.flatMap((g) =>
      g.members.map((m) => ({ user: `user:${m}`, relation: 'member', object: `group:${g.id}` })),
    ),
    ...employees.map(employeeTuple),
    ...grants.map(grantTuple),
  ];
}
