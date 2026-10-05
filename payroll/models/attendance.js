import mongoose from 'mongoose';
import { model, ref } from './common.js';

export const ATTENDANCE_STATUSES = ['present', 'absent', 'half_day', 'late', 'early_leave', 'leave', 'holiday', 'off_day', 'remote'];
export const ATTENDANCE_SOURCES = ['fingerprint', 'manual', 'excel', 'web', 'mobile', 'api', 'leave', 'other'];

/** One row per employee per day. Times are stored as full Date values. */
const attendanceSchema = new mongoose.Schema({
    employee: ref('Employee', { required: true }),
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    checkIn: { type: Date, default: null },
    checkOut: { type: Date, default: null },
    breakMinutes: { type: Number, min: 0, default: 0 },
    workedHours: { type: Number, min: 0, default: 0 },
    normalHours: { type: Number, min: 0, default: 0 },
    otHours: { type: Number, min: 0, default: 0 },
    lateMinutes: { type: Number, min: 0, default: 0 },
    earlyLeaveMinutes: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ATTENDANCE_STATUSES, required: true },
    dayValue: { type: Number, min: 0, max: 1, default: 1 }, // 0.5 for half days
    source: { type: String, enum: ATTENDANCE_SOURCES, default: 'manual' },
    leaveRequest: ref('LeaveRequest'),
    leavePaid: { type: Boolean, default: null },
    remarks: { type: String, trim: true, maxlength: 500, default: '' },
    reason: { type: String, trim: true, maxlength: 300, default: '' }, // why a manual entry / change was made
    approvedBy: ref('User'),
    importBatch: ref('ImportBatch'),
    missingCheckout: { type: Boolean, default: false },
});
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
attendanceSchema.index({ date: 1, status: 1 });
export const Attendance = model('Attendance', attendanceSchema);

/** Raw punches from biometric devices / web / API, kept for audit and re-processing. */
const attendanceEventSchema = new mongoose.Schema({
    device: ref('BiometricDevice'),
    employee: ref('Employee'),
    biometricUserId: { type: String, trim: true, maxlength: 40, default: '' },
    timestamp: { type: Date, required: true },
    eventType: { type: String, enum: ['in', 'out', 'break_out', 'break_in', 'unknown'], default: 'unknown' },
    source: { type: String, enum: ['fingerprint', 'web', 'mobile', 'api', 'file'], default: 'fingerprint' },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: ['pending', 'processed', 'error', 'ignored', 'duplicate'], default: 'pending', index: true },
    error: { type: String, default: '' },
    syncedAt: { type: Date, default: Date.now },
    processedAt: { type: Date, default: null },
}, {});
attendanceEventSchema.index({ device: 1, biometricUserId: 1, timestamp: 1 }, { unique: true });
attendanceEventSchema.index({ employee: 1, timestamp: 1 });
export const AttendanceEvent = model('AttendanceEvent', attendanceEventSchema, { softDelete: false });

const biometricDeviceSchema = new mongoose.Schema({
    deviceCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    serialNumber: { type: String, trim: true, maxlength: 60, default: '' },
    ipAddress: { type: String, trim: true, maxlength: 60, default: '' },
    port: { type: Number, min: 0, max: 65535, default: null },
    location: ref('OrgUnit'),
    branch: ref('OrgUnit'),
    protocol: { type: String, enum: ['push_api', 'zkteco', 'csv_file', 'other'], default: 'push_api' },
    // first_last: first punch of the day = in, last = out. explicit: use the device's IN/OUT flags.
    eventMode: { type: String, enum: ['first_last', 'explicit'], default: 'first_last' },
    // Punches closer together than this are treated as duplicates.
    duplicateWindowMinutes: { type: Number, min: 0, default: 2 },
    timezoneOffsetMinutes: { type: Number, default: 330 }, // device clock offset from UTC (Sri Lanka +05:30)
    apiKeyHash: { type: String, default: '', select: false },
    apiKeyHint: { type: String, default: '' },
    status: { type: String, enum: ['online', 'offline', 'unknown', 'error'], default: 'unknown' },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
    active: { type: Boolean, default: true },
});
biometricDeviceSchema.index({ deviceCode: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
export const BiometricDevice = model('BiometricDevice', biometricDeviceSchema);

/** Excel / CSV attendance import kept between "validate" and "confirm". */
const importBatchSchema = new mongoose.Schema({
    kind: { type: String, enum: ['attendance'], default: 'attendance' },
    fileName: { type: String, default: '' },
    status: { type: String, enum: ['validated', 'imported', 'discarded'], default: 'validated' },
    totalRows: { type: Number, default: 0 },
    validRows: { type: Number, default: 0 },
    errorRows: { type: Number, default: 0 },
    overwrite: { type: Boolean, default: false },
    rows: [{ _id: false, row: Number, data: mongoose.Schema.Types.Mixed, problems: [String], warnings: [String] }],
    importedCount: { type: Number, default: 0 },
    importedAt: { type: Date, default: null },
});
export const ImportBatch = model('ImportBatch', importBatchSchema, { softDelete: false });
