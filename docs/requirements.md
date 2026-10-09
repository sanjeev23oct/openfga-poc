# Requirements: zone-based employee access control

As of 9 October 2026. Design: [tech-design.md](tech-design.md).

Access to an employee record is decided by three things: where the employee sits in the
organisation, which department they belong to, and which role the viewer holds at which level.

## Organisation structure

- **R1.** India is divided into 4 zones. Each zone has areas, each area has centres, and a centre
  may have sub-centres.
- **R2.** Every employee is attached to exactly one unit: a zone, an area, a centre or a sub-centre.
- **R3.** Every employee belongs to exactly one department (for example HR, Finance, Operations).
- **R4.** Units can be added, moved or closed without rewriting access for each user or employee.

## Roles

The same three roles exist at every level: zone, area, centre and sub-centre.

| Role | View basic data | Edit basic data | View salary data |
| --- | --- | --- | --- |
| Admin | Yes | Yes | No |
| Coordinator | Yes | No | No |
| Salary coordinator | Yes | No | Yes |

- **R5.** A role held on a unit applies to every employee in that unit and in all units below it.
  A zone admin reaches every employee in the zone's areas, centres and sub-centres.
- **R6.** A role never applies upwards or sideways. A centre admin sees nothing in a sibling centre
  or in the parent area's other centres.
- **R7.** Salary data is a separate permission from basic data. Holding Admin does not reveal salary.
- **R8.** One user can hold different roles on different units, for example Admin on one centre and
  Coordinator on another area.

## Scoped grants

- **R9.** A user can be given a role on a chosen subset of centres inside an area, without getting
  the whole area.
- **R10.** A user can be given a role on a chosen subset of areas inside a zone, without getting the
  whole zone.
- **R11.** A role grant can be limited to one or more departments. An HR coordinator for the North
  zone sees only HR employees in that zone.
- **R12.** Removing a grant takes effect on the next request, with no recalculation job.

## What the application must be able to ask

- **R13.** Can user U perform action A (view basic, edit basic, view salary) on employee E?
- **R14.** Which employees can user U see? This drives list and search screens.
- **R15.** Who can see employee E's salary? This is needed for audit.

## Assumptions to confirm

- Admin does not see salary. If Admin should include salary, it is a one-line change in the model.
- Salary coordinator can also read basic data, since salary screens need the employee's name and unit.
- A country-level role above the four zones is included for national HR.

## Scenarios the POC must prove

All 12 pass in the POC, both as model tests (`fga/store.fga.yaml`) and through the running API
(`app/scripts/scenarios.js`).

| # | Scenario | Expected result | Requirement |
| --- | --- | --- | --- |
| 1 | Anita is admin of North zone | Sees and edits all 11 North employees at every level, no salary | R5, R7 |
| 2 | Anita opens a South zone employee | Not found | R6 |
| 3 | Bala is coordinator of North zone | Sees the same 11, cannot edit | R7 |
| 4 | Chitra is salary coordinator of North zone | Sees salary for all 11, cannot edit | R7 |
| 5 | Deepak is admin of Delhi area | Sees Delhi centres and sub-centres, not Punjab, not zone-level staff | R5, R6 |
| 6 | Esha is coordinator of Rohini and Dwarka only | Sees those two centres and Rohini's sub-centres, not Saket | R9 |
| 7 | Farhan is admin of Karnataka and Kerala only | Does not see Tamil Nadu in the same zone | R10 |
| 8 | Gita is coordinator of North zone, HR only | Sees 4 HR employees out of 11 | R11 |
| 9 | Hari is salary coordinator of West (Finance only) and admin of Pune | Salary for West finance staff, edit for everyone in Pune | R8, R11 |
| 10 | Jaya is a member of the payroll-south group | Sees South salaries through one group grant | R5 |
| 11 | Saket centre moves from Delhi to Punjab | Deepak loses it on the next request, a user granted on the centre keeps it | R4 |
| 12 | A grant is removed | Access is gone on the next request | R12 |

## Open questions

- [ ] Should Admin see salary?
- [ ] Can an employee belong to more than one unit or department?
- [ ] Is a role above zones needed for national HR, and which roles?
- [ ] Who is allowed to grant and revoke roles at each level?
- [ ] Expected numbers: employees, units, concurrent users, largest list page?
- [ ] Will other systems such as payroll or attendance reuse these rules?
