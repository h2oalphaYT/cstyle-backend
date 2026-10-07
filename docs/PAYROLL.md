# CStyle Payroll, HR & Attendance

The module sits inside the existing admin panel at **/admin/hr** ("Payroll & HR" in the sidebar). Salary rules, attendance rules, rates and permissions are stored in the database and edited on screen, so they are not hard-coded.

---

## 1. Files created

**Backend (`cstyle-backend`)**

| Path | Purpose |
| --- | --- |
| `payroll/permissions.js` | Permission list, built-in roles, `loadAccess`, `can()` middleware |
| `payroll/routes.js` | Mounts all payroll controllers under `/api` |
| `payroll/models/common.js` | Shared plugin (createdBy/updatedBy, soft delete, timestamps), attachment schema |
| `payroll/models/org.js` | OrgUnit (company/branch/hub/location/department/costCenter/project), Designation, EmployeeGroup, HrLookup, Holiday |
| `payroll/models/employee.js` | Employee, BiometricMapping |
| `payroll/models/salary.js` | SalaryComponent, SalaryStructure, EmployeeSalary (revisions), TaxTable |
| `payroll/models/attendance.js` | Attendance, AttendanceEvent (raw punches), BiometricDevice, ImportBatch |
| `payroll/models/leave.js` | LeaveType, LeaveBalance, LeaveRequest, OvertimeType, OvertimeEntry |
| `payroll/models/finance.js` | Advance/Loan, Installment, PayrollEntry (allowance/bonus/deduction), ExternalPayment |
| `payroll/models/payroll.js` | PayrollPeriod, PayrollRun, PayrollRunEmployee (lines + calculation), PayrollAdjustment |
| `payroll/models/system.js` | StaffRole, PayrollSetting, AuditLog, HrCounter |
| `payroll/models/index.js` | Re-exports |
| `payroll/services/formulaEngine.js` | Safe formula parser/evaluator (no `eval`) |
| `payroll/services/settingsService.js` | Defaults and global → company → group → employee resolution |
| `payroll/services/util.js` | Dates/time zone, transactions, audit helper, period-lock checks |
| `payroll/services/scope.js` | Data scope (all / department / team / own) |
| `payroll/services/attendanceService.js` | Worked/late/early/OT calculation and saving |
| `payroll/services/leaveService.js` | Leave days, balances, two-step approval |
| `payroll/services/payrollEngine.js` | Per-employee payroll calculation with explanations |
| `payroll/services/payrollService.js` | Runs, workflow, finalize, reverse, payments |
| `payroll/services/biometricService.js` | Device adapters, event ingest, punch → attendance processing |
| `payroll/services/excelService.js` | Import template/validation, Excel/CSV/PDF export |
| `payroll/services/payslipPdf.js` | Payslip PDF |
| `payroll/services/reportService.js` | 23 reports |
| `payroll/services/files.js` | Private HR uploads (type check by file signature) |
| `payroll/controllers/crud.js` | Generic permission-aware CRUD router |
| `payroll/controllers/setupRoutes.js` | Org, lookups, holidays, leave/OT types, components, structures, tax tables, roles, biometric devices/mappings |
| `payroll/controllers/employeeRoutes.js` | Employees, documents, login link, leave balances, salary revisions |
| `payroll/controllers/attendanceRoutes.js` | Attendance, Excel import, biometric API, overtime, leave requests |
| `payroll/controllers/financeRoutes.js` | Advances, loans, entries, external payments, adjustments |
| `payroll/controllers/payrollRoutes.js` | Periods, runs, payslips, reports, dashboard, settings, audit log, staff users, self-service |
| `scripts/migrate-payroll.js` | Setup/migration (`npm run migrate`) |
| `scripts/seed-payroll-demo.js` | Demo company and test employees A–E (`npm run payroll:demo`) |
| `tests/payroll.test.js` | End-to-end payroll tests (`npm run test:payroll`) |
| `docs/PAYROLL.md` | This guide |

**Frontend (`cstyle-frontend/src/admin/hr`)**

| File | Screens |
| --- | --- |
| `lib.tsx` | Formatters, status tags, employee/org selects, list/action hooks, file download/upload |
| `MasterData.tsx` | Generic table + form page |
| `SetupPages.tsx` | Companies/branches/hubs/departments/cost centers, designations, groups, holidays, leave types, OT types, lookups, biometric devices and user-ID mappings |
| `Employees.tsx` | Employee list, profile form, detail drawer (documents, leave balances, login access) |
| `Salary.tsx` | Salary components (with formula tester), structures, employee salary revisions and payroll preview |
| `Attendance.tsx` | Attendance, Excel import/export, biometric events |
| `Leave.tsx` | Leave requests/balances, overtime |
| `Finance.tsx` | Advances, loans, allowances, bonuses, deductions, external payments |
| `Payroll.tsx` | Payroll processing, run detail with calculation breakdown, adjustments, payslips, reports |
| `Dashboard.tsx` | HR dashboard and "My HR" self-service |
| `Settings.tsx` | Settings, company overrides, roles & permissions, back-office users, tax tables, audit log |
| `nav.tsx` | Sidebar menu definition with permissions |
| `HrRoutes.tsx` | Routes and per-page permission guard |

## 2. Files modified

| File | Change |
| --- | --- |
| `cstyle-backend/models/User.js` | New role `staff`, `staffRole` and `employee` links |
| `cstyle-backend/controllers/authController.js` | Login and `/auth/me` return `permissions` and `dataScope` |
| `cstyle-backend/routes/index.js` | Mounts payroll routes |
| `cstyle-backend/package.json` | Scripts `migrate`, `payroll:demo`, `test:payroll`; deps `exceljs`, `pdfkit` |
| `cstyle-backend/.gitignore` | `private_files/` |
| `cstyle-backend/.env.example`, `README.md` | HR variables and commands |
| `cstyle-frontend/src/App.tsx` | `/admin/hr/*` routes; `/admin` open to admins and staff; store pages stay admin-only |
| `cstyle-frontend/src/admin/components/AdminLayout.tsx` | "Payroll & HR" menu group filtered by permission; staff see only that group |
| `cstyle-frontend/src/context/AuthContext.tsx` | `isBackOffice`, `can(...)` |
| `cstyle-frontend/src/api/types.ts` | `staff` role, permissions on the user |
| `cstyle-frontend/src/pages/Auth.tsx`, `src/components/Header.tsx` | Staff land on / link to Payroll & HR |

Existing store data (products, orders, customers) is untouched; all payroll collections are new.

## 3. Database migrations

MongoDB has no schema migrations; `npm run migrate` (idempotent) does the setup:

* creates indexes for every payroll collection;
* creates the built-in roles PAYROLL_ADMIN, HR_MANAGER, HR_OFFICER, ATTENDANCE_OFFICER, FINANCE_OFFICER, DEPARTMENT_MANAGER, SUPERVISOR, EMPLOYEE (`-- --update-roles` resets their permissions to the defaults);
* global payroll settings, lookups (employment types, document types, banks, external payment types);
* 6 leave types (Annual, Casual, Sick, Maternity, No-pay, Short leave) and 5 overtime types (Normal 1.5×, Weekend 1.5×, Holiday 2×, Night 1.75×, Special 2×);
* 26 system salary components (BASIC, NOPAY, LATE, EPF_EE, EPF_ER, ETF_ER, OT, LOAN, ADVANCE, ATTENDANCE_ALLOW, TAX (inactive)…);
* an inactive sample APIT tax table and 4 sample structures: MONTHLY_OFFICE, GOVT_SCHOOL, RESTAURANT_HOURLY, DAILY_WORKER.

Re-running never overwrites anything you have edited.

## 4. API endpoints (all under `/api`, JWT required unless noted)

| Area | Endpoints |
| --- | --- |
| Organisation | `GET/POST/PUT/DELETE /hr/org-units`, `/hr/designations`, `/hr/employee-groups`, `/hr/lookups`, `/hr/holidays` |
| Employees | `GET/POST /employees`, `GET/PUT/DELETE /employees/:id`, `POST /employees/:id/documents`, `GET/DELETE /employees/:id/documents/:docId`, `POST /employees/:id/user`, `GET /employees/:id/leave-balances`, `PATCH /leave-balances/:id` |
| Salary setup | CRUD `/salary-components`, `GET /salary-components/variables`, `POST /salary-components/test-formula`, CRUD `/salary-structures`, CRUD `/tax-tables` |
| Employee salary | `GET/POST /employee-salaries`, `PUT/DELETE /employee-salaries/:id` |
| Attendance | `GET/POST /attendance`, `DELETE /attendance/:id`, `GET /attendance/today`, `GET /attendance/export` |
| Excel import | `GET /attendance/import/template`, `POST /attendance/import/validate`, `GET /attendance/import/:id`, `GET /attendance/import/:id/errors`, `POST /attendance/import/:id/commit`, `DELETE /attendance/import/:id` |
| Biometric | `POST /biometric/events` and `/biometric/attendance` (device key, no JWT), `GET /biometric/events`, `POST /biometric/process`, `POST /biometric/sync`, `POST /biometric/events/upload`, `GET /biometric/adapters`, CRUD `/biometric/devices`, `POST /biometric/devices/:id/api-key`, CRUD `/biometric/mappings` |
| Leave | CRUD `/leave-types`, `GET/POST /leave-requests`, `PATCH /leave-requests/:id/approve|reject|cancel`, `GET /leave-requests/:id/documents/:docId` |
| Overtime | CRUD `/overtime-types`, `GET/POST /overtime`, `PATCH /overtime/:id/approve|reject`, `POST /overtime/bulk-approve`, `DELETE /overtime/:id` |
| Advances & loans | `GET/POST /advances` and `/loans`, `PATCH …/:id/approve|cancel`, `GET …/:id/schedule`, `PATCH …/:id/installments/:instId/skip` |
| Pay items | `GET/POST /payroll-entries`, `DELETE /payroll-entries/:id`; `GET/POST /external-payments`, `PATCH /external-payments/:id/approve|reject`, attachments, `DELETE` |
| Payroll | `GET/POST /payroll/periods`, `PATCH /payroll/periods/:id/lock|unlock`; `GET/POST /payroll/runs`, `POST /payroll/calculate`, `POST /payroll/preview`, `GET /payroll/runs/:id`, `GET /payroll/runs/:id/employees(/:lineId)`, `POST /payroll/runs/:id/calculate|submit|approve|return|finalize|cancel|payments`, `POST /payroll/finalize`, `GET /payroll/payments`, `GET /payroll/runs/:id/export?format=xlsx|csv|pdf` |
| Adjustments | `GET/POST /payroll/adjustments`, `PATCH /payroll/adjustments/:id/cancel` |
| Payslips | `GET /payslips`, `GET /payslips/:lineId/pdf`, `GET /payroll/runs/:id/payslips.pdf` |
| Reports | `GET /payroll/reports`, `GET /payroll/reports/:type?from&to&employee&company&branch&hub&department&group&status&format=xlsx|csv|pdf` |
| Dashboard / settings | `GET /payroll/dashboard`, `GET/PUT /payroll/settings`, `GET /payroll/audit-logs` |
| Access | `GET /payroll/permissions`, CRUD `/payroll/roles`, `GET/POST /payroll/staff-users`, `PATCH /payroll/staff-users/:id`, `GET /payroll/me` |

## 5. Environment variables (new)

| Variable | Default | Purpose |
| --- | --- | --- |
| `HR_TZ_OFFSET` | `+05:30` | Time zone for attendance days and device punches |
| `HR_FILES_DIR` | `private_files/hr` | Private storage for HR documents (never publicly served) |
| `HR_MAX_FILE_SIZE` | 10 MB | Max HR upload size in bytes |
| `DEMO_STAFF_PASSWORD` | random | Password of demo staff logins (development only) |

Existing variables (`MONGODB_URI`, `JWT_SECRET`, …) are unchanged. For multi-step payroll writes to be atomic, MongoDB must be a replica set (Atlas always is); on a standalone server the module still works without transactions.

## 6. Run the backend

```bash
cd cstyle-backend
npm install
npm run migrate          # first time, and after updates
npm run dev              # http://localhost:5000
```

## 7. Run the frontend

```bash
cd cstyle-frontend
npm install
npm run dev              # http://localhost:5173 → /admin/hr
```

## 8. Run migrations

```bash
npm run migrate                       # safe to repeat
npm run migrate -- --update-roles     # also reset built-in role permissions
npm run payroll:demo                  # optional demo data (employees DEMO-A…E, January 2025)
npm run payroll:demo -- --reset       # recreate the demo data
npm run test:payroll                  # with the server running
```

### Shop staff and the monthly salary sheet

The shop's existing Excel sheet (one row per worker, day columns 1–31, OT / LATE HOURS / SUNDAYS / SUNDY II / ADVANCE / SALARY) is supported directly:

* `npm run import:staff -- private_files/<staff>.json [--check]` adds workers from a JSON list kept in the gitignored `private_files/` folder. It creates the **Shop Staff** group (25-day month, Sunday off), the **SHOP_DAILY** structure and the **SUNDAY_PAY** component. `--check` recalculates the sheet's salaries with the system formulas.
  * daily rate = basic ÷ 25; pay for days = daily rate × days worked
  * hourly rate = daily rate ÷ 8; OT = OT hours × hourly rate; late = late hours × hourly rate
  * Sunday pay = full Sundays × the worker's Sunday rate + extra Sunday hours × round(rate ÷ 8)
  * no EPF/ETF; fixed-salary staff use an override `BasicSalary`
* **Excel Import / Export → Import monthly salary sheet**: choose the month, upload the sheet, review, then import. Weekday marks become attendance; OT, Sunday hours, late hours and advances become approved entries for that month. Re-uploading a month replaces the earlier import, and **Undo** removes it while the month is open (`POST /api/attendance/monthly-sheet/validate`, `…/:id/commit`, `…/:id/revert`, `GET /api/attendance/monthly-sheet`).
* `npm run test:sheet` checks this end to end with temporary employees.

## 9. Create an admin or payroll user

* Store administrators (`role: admin`) already have every payroll permission. The first admin comes from `npm run seed` (`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`).
* For payroll/HR staff: **Payroll & HR → Payroll Settings → Back-office users → Give access**. Enter name, email, a password (for a new account) and a role, e.g. *Payroll Admin*, *HR Officer*, *Finance Officer*. Existing customer accounts are upgraded and keep their password.
* For employee self-service, open the employee → *Login access* (or link the employee when giving access). They get the *Employee* role and only see **My HR** (leave requests, balances, their own payslips).
* Roles can be edited or new ones created under *Roles & permissions*, including which employees each role can see (all / own department / own team / only themselves).

## 10. Configure a salary structure

1. **Salary Components**: check the system components and add your own (e.g. `TRAVEL`, fixed 5000; `MEAL`, `perAttendanceDay` 300). Formula components use variables such as `BasicSalary`, `WorkingDays`, `PresentDays`, `NoPayDays`, `LateMinutes`, `OTHours`, `HourlyRate`, `DailyRate`, `GrossSalary`, `EPFBase`, other component codes, and functions `min max round floor ceil abs if slab`. Use **Test formula** before saving.
2. **Salary Structures**: create one (e.g. "Office Monthly"), pick the pay basis, and add components in order. Each line may override the value or formula.
3. **Employee Salary**: open an employee → **New revision**: structure, effective date, basic salary or daily/hourly rate, optional OT rate and per-employee overrides. Saving closes the previous revision automatically; history is never overwritten, and revisions used in a finalized payroll cannot be edited.
4. Use **Preview** on that screen to see a month's calculation before running payroll.

## 11. Process the first payroll

1. Make sure attendance for the month is in (manual, Excel import or biometric) and leave / overtime are approved.
2. Add advances, loans, allowances, bonuses, deductions and external payments for the month if any.
3. **Payroll Processing → New payroll run**: choose the month and optionally a company/branch/hub/department/group or specific employees. It creates and calculates the run.
4. Open the run: check the totals and the *Issues* column (missing bank details or negative net pay block approval). Click any employee for the full breakdown with formulas and inputs. Fix data and **Recalculate** as often as needed.
5. **Submit for review**, then a different user **Approves** (the calculator cannot approve their own run unless they are an admin).
6. **Finalize**: loan/advance installments are recorded as recovered, pay items marked processed and payslips numbered. Corrections after this go through **Adjustments** into a later month.
7. **Export** the bank payment list (Excel/CSV/PDF), pay the staff, then **Record payment** (status, method, date, reference).
8. Optionally **Lock** the period on the left to block any further attendance/salary changes for that month (unlocking needs a reason and is audited).

## 12. How biometric integration works

* Every device is registered under **Biometric Devices** with a code, location, protocol and event mode (*first in / last out* or *explicit in/out*). Each employee's device user ID goes in **Biometric User IDs**.
* **Push** (recommended): issue an API key on the device page (shown once; only its hash is stored). The device, or a small agent next to it, posts punches to `POST /api/biometric/events` with headers `X-Device-Code` and `X-Device-Key`, body `{ "events": [{ "biometricUserId": "1001", "timestamp": "2026-10-05T08:29:00+05:30", "eventType": "in" }] }`.
* **File**: export the log from the device and upload it on **Biometric Events** (columns *User ID, Timestamp, Type*).
* Raw punches are stored in `AttendanceEvent` first. **Process pending** (or the automatic processing after each push) removes duplicates within the device's window, maps users to employees and builds attendance with late/early/OT using the same rules as manual entry. Manually entered or corrected attendance is never overwritten. Unmatched punches stay pending until a mapping is added.
* **Pull adapters** (e.g. ZKTeco over TCP) plug into `ADAPTERS` in `payroll/services/biometricService.js`: implement `pull(device, since)` returning events and they flow through the same pipeline via **Sync** (`POST /api/biometric/sync`). The ZKTeco adapter is a stub today.

## 13. Garment factory: leave, holidays, roles and daily target

**One-time setup on the server** (both are safe to repeat and only add what is missing):

```bash
docker compose exec -T api npm run setup:garment          # roles + Sri Lanka holidays for this year and next
docker compose exec -T api npm run payroll:remove-demo     # shows what demo data would be removed
docker compose exec -T api npm run payroll:remove-demo -- --yes
docker compose exec -T api npm run migrate -- --update-roles   # optional: built-in roles get the production permissions (resets their permission edits)
```

* **Roles.** `setup:garment` adds CEO, Factory Manager, Supervisor, Quality Checker, Cutter, Machine Operator, Ironer / Packer and Helper as designations (job title) and employee groups (pay rules per role, default structure *Monthly Office Salary*). Edit or add more under Organization → Designations and People → Employee Groups. The migration also adds two back-office roles: *Factory Manager* and *Production Board (TV)* (can only open the target board).
* **Demo data.** `payroll:remove-demo` deletes only the DEMO-* employees and the "DEMO …" company, groups, holiday, device, demo payroll and @demo.cstyle.lk logins. It refuses, and says why, while any real employee or payroll still points at demo data. Admin users, products and orders are never touched. Deploys never run it.
* **Leave.** While a leave request is filled in, the form shows the employee's leave count for that month and whether the request is paid or no-pay, and why. Rules (Payroll Settings → Working time & attendance): an unpaid leave type is always no-pay; days beyond the remaining balance become no-pay (*Leave beyond balance becomes no-pay*, on by default; turn it off to refuse such requests instead); *Paid leave days per month* (0 = no limit) makes extra days in a month no-pay. No-pay days are not taken from the balance and payroll deducts them through the NOPAY component. The Leave list shows each request's paid/no-pay split and the employee's leave total for the month.
* **Holidays.** The Sri Lanka gazette for 2026 and 2027 (public, bank, mercantile, all Poya days) is in `payroll/data/sriLankaHolidays.js`; add the next year there when it is published. Every holiday has a *Factory closed* switch: closed days are not working days for attendance, leave and payroll (work on them is holiday OT); days switched to *Working* stay on the calendar only. `setup:garment -- --mercantile-only` closes only on mercantile holidays.
* **Daily target.** Production → Daily Target: supervisors add finished pieces through the day (+5/+10/+20/+50 or a number), managers set the default target (120) and a different target for a single day. **Factory TV Board** (`/factory-board`) is a full-screen page for the floor TV: pieces done vs target, pace, hour-by-hour output, the week, the streak of days on target and the next holiday. It refreshes every 30 seconds and keeps the screen awake. Log the TV in with a user that has the *Production Board (TV)* role.

| Endpoint | Purpose |
| --- | --- |
| `POST /leave-requests/preview` | Days, paid / no-pay split and reason, month leave count, balance |
| `GET /production/board?date` | Everything the TV board shows |
| `GET /production/summary?from&to` | Target vs achieved per day |
| `GET/POST /production/logs`, `DELETE /production/logs/:id` | Finished pieces |
| `GET /production/targets`, `PUT/DELETE /production/targets/:date` | A day's own target |
| `GET/PUT /production/settings` | Default target, item name, shift hours, TV message |

## 14. Remaining TODOs

* ZKTeco/other SDK pull adapters (only the stub exists) and a scheduled sync job.
* The sample APIT tax table is inactive. Load the current Inland Revenue brackets and activate the `TAX` component before using it.
* Bank-specific transfer file formats (e.g. per-bank CSV layouts); today the bank payment report is a generic Excel/CSV/PDF.
* Weekly/bi-weekly pay frequencies are stored and shown, but payroll periods are monthly.
* Email delivery of payslips and approval notifications.
* Leave accrual is yearly opening + manual adjustments; monthly accrual and carry-forward rules are not automated.
* Optional: a separate frontend bundle split for antd (build warns about chunk size; not a functional issue).
