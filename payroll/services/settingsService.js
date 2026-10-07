import { EmployeeGroup, PayrollSetting } from '../models/index.js';

/**
 * Built-in defaults. Every value can be changed in Payroll Settings (global), overridden per company,
 * per employee group, and (for working days/hours) per employee.
 */
export const DEFAULT_SETTINGS = {
    currency: 'LKR',
    workingDaysPerMonth: 26,
    workingHoursPerDay: 8,
    weeklyOffDays: [0], // 0 = Sunday ... 6 = Saturday
    workdayStart: '08:30',
    workdayEnd: '17:00',
    defaultBreakMinutes: 60,
    lateGraceMinutes: 10,
    earlyLeaveGraceMinutes: 10,
    attendanceRoundingMinutes: 0, // round worked minutes down to this block
    halfDayMinHours: 4,
    autoOvertimeFromAttendance: true, // hours beyond the normal day become pending OT entries
    otMinimumMinutes: 30,
    defaultOtMultiplier: 1.5,
    missingAttendance: 'ignore', // 'ignore' | 'absent' — how payroll treats scheduled days with no record
    payrollDay: 25,
    payFrequency: 'monthly',
    defaultPaymentMethod: 'bank_transfer',
    defaultEmployeeGroup: null,
    nicPattern: '^([0-9]{9}[VvXx]|[0-9]{12})$', // Sri Lankan NIC (old or new format)
    bankAccountPattern: '^[0-9]{6,20}$',
    requireBankForBankTransfer: true,
    allowLeaveBeyondBalance: false, // true = leave beyond the balance is still paid (balance goes negative)
    excessLeaveAsNoPay: true, // otherwise leave beyond the balance becomes no-pay; false = such requests are refused
    monthlyPaidLeaveLimit: 0, // paid leave days allowed per calendar month; the rest becomes no-pay (0 = no monthly limit)
    leaveYearStartMonth: 1,
    epfEmployeeRate: 8,
    epfEmployerRate: 12,
    etfRate: 3,
    roundNetTo: 0, // 0 = cents; 1 = nearest rupee; 10 = nearest 10
    companyName: 'CStyle',
    companyAddress: '',
    payslipFooter: 'This is a computer-generated payslip.',
    dailyProductionTarget: 120, // finished pieces per day shown on the factory board
    productionItem: 'pieces', // what is counted, e.g. "pants"
    productionShiftStart: '08:00', // the board's hour-by-hour chart runs from start to end
    productionShiftEnd: '17:00',
    productionBoardMessage: 'Every piece counts. Together we hit the target!',
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export const getGlobalSettings = async () => {
    const doc = await PayrollSetting.findOne({ scope: 'global', scopeRef: null }).lean();
    return { ...DEFAULT_SETTINGS, ...(doc?.values || {}) };
};

/**
 * Settings for one employee: global → company → employee group → employee overrides.
 * Pass caches (Maps) when resolving many employees in one payroll run.
 */
export const resolveSettings = async (employee, cache = {}) => {
    cache.global ??= await getGlobalSettings();
    let merged = { ...cache.global };
    if (employee?.company) {
        const key = String(employee.company._id || employee.company);
        cache.company ??= new Map();
        if (!cache.company.has(key)) {
            const doc = await PayrollSetting.findOne({ scope: 'company', scopeRef: key }).lean();
            cache.company.set(key, doc?.values || {});
        }
        merged = { ...merged, ...cache.company.get(key) };
    }
    if (employee?.group) {
        const key = String(employee.group._id || employee.group);
        cache.group ??= new Map();
        if (!cache.group.has(key)) {
            const group = employee.group.settings ? employee.group : await EmployeeGroup.findById(key).lean();
            cache.group.set(key, group?.settings || {});
        }
        merged = { ...merged, ...cache.group.get(key) };
    }
    if (employee?.workingDaysPerMonth != null) merged.workingDaysPerMonth = employee.workingDaysPerMonth;
    if (employee?.workingHoursPerDay != null) merged.workingHoursPerDay = employee.workingHoursPerDay;
    return merged;
};

/** Only known keys with the same type as the default are stored. */
export const sanitizeSettings = (values = {}) => {
    const out = {};
    for (const [key, value] of Object.entries(values)) {
        if (!SETTING_KEYS.includes(key) || value === undefined) continue;
        const def = DEFAULT_SETTINGS[key];
        if (def === null) out[key] = value;
        else if (Array.isArray(def)) {
            if (Array.isArray(value)) out[key] = value.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
        } else if (typeof def === 'number') {
            const n = Number(value);
            if (Number.isFinite(n) && n >= 0) out[key] = n;
        } else if (typeof def === 'boolean') out[key] = Boolean(value);
        else out[key] = String(value).slice(0, 300);
    }
    return out;
};
