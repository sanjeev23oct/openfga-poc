# Listing employees: OpenFGA, a share table, and a custom build

As of 9 October 2026, against OpenFGA v1.22.0. Background: [tech-design.md](tech-design.md).

Checking one employee is easy in OpenFGA. Listing employees is where it needs extra design, because
the employee data is in the HR database and the access rules are in OpenFGA, and neither can answer
"Finance employees I can see, sorted by name, page 3" alone.

For this project the answer is workable: ask OpenFGA which **units** the user has access to, then
let the HR database do the filtering, sorting, paging and totals. The rest of this file explains
why, what the other options cost, and how a custom implementation without OpenFGA would do the
same job.

## See it running

The app's "Filters and reports" screen runs one filtered, sorted, paged list and one report four
ways against live data, and shows what each way fetched and whether its answer was right:

| Way in the app | What this file calls it |
| --- | --- |
| Page first, then check | batch-check applied to one page; the short-page and wrong-total problem |
| Pull everything, then check | batch-check applied to every matching row |
| Ask for units first, then query | list-units |
| SQL tables only | The custom implementation |

Code: [`app/src/reports.js`](../app/src/reports.js). Employee data and the SQL-only grant tables
sit in an in-memory SQLite database, rebuilt from the current OpenFGA tuples on each request.

## The example screen

> Employees in Finance, sorted by name, 50 per page, page 3, for the logged-in user.
> Show the total count and the salary column where allowed.

## How a share table does it

A share table (Salesforce, or a custom `employee_share` table) holds one row per user per employee
they can see. Access is one more table to join:

```sql
SELECT e.*
FROM employee e
JOIN employee_share s ON s.employee_id = e.id AND s.user_id = :user
WHERE e.department = 'finance'
ORDER BY e.name
LIMIT 50 OFFSET 100;
```

The database filters, sorts, pages and counts in one step. The cost is paid earlier: every grant,
transfer or reorganisation has to rewrite share rows.

## How OpenFGA does it: three strategies

All three are implemented in [`app/src/fga.js`](../app/src/fga.js) and selectable from the
"List strategy" dropdown in the UI. They return identical results for every persona.

### 1. batch-check: search, then check

1. The HR database runs the filter, sort and page: `WHERE department = 'finance' ORDER BY name LIMIT 50`.
2. The API sends those 50 rows to OpenFGA BatchCheck, with each employee's department as context.
3. The API drops the rows that were denied.

| Pros | Cons |
| --- | --- |
| Simplest to build | Pages come back short or empty when the user can see only a small share of the rows |
| One OpenFGA call per page (the SDK splits it into requests of 50 checks) | The API may scan many pages to fill one |
| The database keeps doing filter and sort | No total count or "page 1 of N" without checking every row |
| Always correct at the moment of the request | Totals and reports need every row checked |

Fits: screens where the user can see most of what the query returns, such as a zone admin browsing
their own zone, or opening one employee.

### 2. list-objects: list IDs, then search

1. The API calls OpenFGA ListObjects for type `employee`. Because of department-limited grants this
   is one call per department and permission (12 calls in the POC: 4 departments, 3 permissions).
2. The HR database runs the query with `WHERE id IN (...those IDs...)`.

| Pros | Cons |
| --- | --- |
| The database does filter, sort, page and count correctly | The ID list grows with the user's access; a national coordinator gets every employee ID |
| No empty pages | ListObjects stops at 1,000 results or 3 seconds by default, so large lists are cut short unless the limits are raised |
| | A very long `IN (...)` list is slow and has size limits in most databases |
| | Needs one placement tuple per employee in OpenFGA |

Fits: small organisations, or users who can see at most a few hundred employees.

### 3. list-units: list units, then search

1. The API calls OpenFGA ListObjects for each unit type (zone, area, centre, sub-centre), per
   department and permission. This returns the units the user holds each permission on.
2. The HR database runs the query with unit and department filters:

```sql
SELECT e.* FROM employee e
WHERE e.department = 'finance'
  AND e.unit_id IN (:units_where_user_can_view_finance)
ORDER BY e.name
LIMIT 50 OFFSET 100;
```

| Pros | Cons |
| --- | --- |
| The database does filter, sort, page, count and totals correctly | Many OpenFGA calls per request (48 in the POC: 4 unit types, 4 departments, 3 permissions) |
| Cost does not grow with the number of employees, only with units and departments | The API must build the unit filter itself, which is more code |
| The unit list is small (hundreds) and stable, so it can be cached per user for a few seconds | Only works because access follows the organisation tree |
| Employee placement tuples are no longer needed in OpenFGA | A cached unit list means a revoked grant can linger for the cache lifetime |

Fits: this project at real scale, including exports, reports and totals.

### A fourth option not built: local index

OpenFGA has a changes feed (`ReadChanges`). A background job can consume it and maintain your own
`employee_share`-style table, which the list query then joins. This is a share table that you build
and keep in step yourself. The OpenFGA guide suggests still checking the final page, to catch
revocations the index has not received yet. It is the most work and is only worth it when the
strategies above are measured and found too slow.

## How a custom implementation does it

A custom build does not need a share table either. It stores the same facts OpenFGA stores (the
tree and the grants) in your own HR database, plus one helper table that makes the tree fast to
query. Access is then worked out inside the SQL query, at request time.

### Tables

```sql
CREATE TABLE org_unit (
  id text PRIMARY KEY, type text NOT NULL, name text NOT NULL,
  parent_id text REFERENCES org_unit
);

-- Every ancestor/descendant pair, including each unit paired with itself.
-- North zone has a row for itself, each of its areas, each centre and each sub-centre.
CREATE TABLE unit_closure (
  ancestor_id text REFERENCES org_unit, descendant_id text REFERENCES org_unit,
  depth int NOT NULL, PRIMARY KEY (ancestor_id, descendant_id)
);

-- One row per grant. departments NULL means all departments.
CREATE TABLE role_grant (
  id serial PRIMARY KEY, user_id text, group_id text,
  role text NOT NULL, unit_id text NOT NULL REFERENCES org_unit, departments text[]
);

CREATE TABLE group_member (group_id text, user_id text, PRIMARY KEY (group_id, user_id));

-- Which role gives which permission: the equivalent of the can_* lines in the OpenFGA model.
CREATE TABLE role_permission (role text, permission text, PRIMARY KEY (role, permission));
```

`employee` already has `unit_id` and `department`.

### The example screen

```sql
SELECT e.*
FROM employee e
WHERE e.department = 'finance'
  AND EXISTS (
    SELECT 1
    FROM unit_closure c
    JOIN role_grant g      ON g.unit_id = c.ancestor_id
    JOIN role_permission p ON p.role = g.role
    WHERE c.descendant_id = e.unit_id
      AND p.permission = 'can_view_basic'
      AND (g.user_id = :user
           OR g.group_id IN (SELECT group_id FROM group_member WHERE user_id = :user))
      AND (g.departments IS NULL OR e.department = ANY (g.departments))
  )
ORDER BY e.name
LIMIT 50 OFFSET 100;
```

Read it as: keep an employee if some grant for this user sits on the employee's unit or on any unit
above it, the grant's role gives the permission, and the grant covers the employee's department.
A single check is the same query with `AND e.id = :employee`. Counts, sums and reports use the same
`EXISTS` clause.

### Changes

| Event | What is written |
| --- | --- |
| Grant or revoke a role | 1 row in `role_grant` |
| Employee joins, transfers or changes department | 1 row in `employee`, nothing else |
| New centre | 1 row in `org_unit`, plus one closure row per ancestor (about 4) |
| Centre moves to another area | Closure rows for the centre's subtree are deleted and re-inserted, in one transaction |
| A role gains a permission | 1 row in `role_permission` |

### What was tried

I ran this schema and query in a throwaway Postgres database with a cut-down copy of the seed data
(6 units, 5 employees, 5 grants). It gave the same answers as the OpenFGA model for a zone admin, an
area admin, a centre coordinator, an HR-only coordinator and a group grant, and an area admin lost a
centre after it was moved. It is not built into the POC app and not tested beyond that.

### Pros and cons

| Pros | Cons |
| --- | --- |
| Lists, counts, sums and reports are one SQL query | You design, build, test and maintain the access logic yourself |
| Filter, sort and paging are always correct | The `EXISTS` clause must be added to every query that touches employees; one forgotten query is a leak |
| Department-limited grants are a plain column test, with no per-department calls | Other applications cannot reuse the rules without calling your API or copying the SQL |
| No extra service to run, and no second store to keep in step | New kinds of rule (temporary access, delegation, per-record exceptions) mean schema and query changes |
| Grants and transfers are one row and take effect at once | The closure table must be kept correct on every tree change; a bug there silently changes access |
| Everything is in one transaction with the HR data | No built-in test format, audit query or tooling; you write those too |

## What the POC measured

25 employees, one request each, on a laptop, with nothing tuned or cached. Read these as relative.

| Persona | Strategy | OpenFGA calls | Time in OpenFGA |
| --- | --- | --- | --- |
| Indu (sees all 25) | batch-check | 1 | 56 ms |
| Indu | list-objects | 12 | 78 ms |
| Indu | list-units | 48 | 767 ms |
| Esha (sees 6) | batch-check | 1 | 23 ms |
| Esha | list-objects | 12 | 65 ms |
| Esha | list-units | 48 | 661 ms |

At this size batch-check wins because the app checks all 25 employees in one go. That ordering is
not expected to hold at 10,000 employees, where batch-check and list-objects grow with employee
count and list-units does not. **This has not been load-tested.**

## Side by side

| Need | Share table | Custom closure table | OpenFGA batch-check | OpenFGA list-objects | OpenFGA list-units |
| --- | --- | --- | --- | --- | --- |
| Check one employee | One lookup | One query | One call | One call | One call |
| Filter, sort, page | In the query | In the query | In the query, but pages can come back short | In the query | In the query |
| Total count | In the query | In the query | Needs every row checked | In the query | In the query |
| Sums and reports | In the query | In the query | Needs every row checked | In the query, if the ID list fits | In the query |
| User sees a small share of rows | Fine | Fine | Poor | Fine | Fine |
| User sees nearly everything | Fine | Fine | Fine | Poor: huge ID list | Fine |
| Cost of a new grant | Many share rows written | 1 row | 1 tuple | 1 tuple | 1 tuple |
| Cost of moving a centre | Share rows recalculated | Closure rows for the subtree rewritten | 1 tuple changed | 1 tuple changed | 1 tuple changed |
| Stale access after a change | Until recalculation finishes | None | None | None | None, or the cache lifetime if units are cached |
| Rows stored for 10,000 employees | One per user per visible employee | About 2,800 rows | About 10,800 tuples | About 10,800 tuples | About 800 tuples |
| Extra service to run | No | No | Yes | Yes | Yes |
| Rules reusable by other applications | No | No | Yes | Yes | Yes |
| Who writes the access logic | The platform | You | OpenFGA | OpenFGA | OpenFGA, plus your unit filter |

The 10,800 figure assumes 10,000 employees, 500 units and 300 grants. The 800 figure is the same
without employee placement tuples. The 2,800 figure for the custom build is 500 units, about
2,000 closure rows (each unit paired with itself and its 3 or so ancestors) and 300 grants.

## Overall pros and cons of OpenFGA for lists

**Pros**

- Grants, revocations and reorganisations are one or two rows and take effect on the next request.
- No recalculation jobs and no window where stored answers are out of date.
- The same rules serve single checks, lists and "who can see this?" audit queries.
- With list-units, list cost is independent of the number of employees.

**Cons**

- A list always takes two steps across two systems; it can never be a single query.
- Department-limited grants multiply the calls, because one list call can only ask about one department.
- Default limits (1,000 results, 3 seconds) cap ListObjects on employees.
- More application code than a join, and more to test.
- If access were granted employee by employee with no structure, there would be no small set of
  units to list, and only a local index would scale.

## Recommendation for this project

**Choosing between OpenFGA and custom.** For list screens alone, the custom closure table is the
better fit: one query, correct paging and totals, nothing extra to run. OpenFGA earns its place when
the same rules must serve several applications, or when you expect the rules to keep growing. If
this stays one HR application on one database, I would build custom.

**If you choose OpenFGA:**

- Use **Check** for opening and editing one employee.
- Use **list-units** for list screens, exports and totals, and cache each user's unit list for a
  few seconds.
- Keep **batch-check** only as a final safety check on the page being returned, if wanted.
- Cut list-units calls by asking per department only for users who hold a department-limited grant.

The last two bullets are design suggestions that are not built or measured in the POC.

## Sources

- [Search with permissions](https://openfga.dev/docs/interacting/search-with-permissions)
- [Relationship queries](https://openfga.dev/docs/interacting/relationship-queries): ListObjects defaults
- [Conditions](https://openfga.dev/docs/modeling/conditions)
