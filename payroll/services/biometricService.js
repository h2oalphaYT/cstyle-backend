import crypto from 'crypto';
import ApiError from '../../utils/ApiError.js';
import { Attendance, AttendanceEvent, BiometricDevice, BiometricMapping } from '../models/index.js';
import { upsertAttendance } from './attendanceService.js';
import { localDay, localTime } from './util.js';

/**
 * Biometric integration layer.
 *
 *   device / adapter  ──▶  AttendanceEvent (raw, stored as-is)  ──▶  processor  ──▶  Attendance
 *
 * Devices either PUSH punches to POST /api/biometric/events (authenticated with the device API key),
 * or an ADAPTER pulls them (POST /api/biometric/sync). Adapters only translate a device protocol into
 * { biometricUserId, timestamp, eventType } objects; they know nothing about payroll. The processor
 * turns punches into check-in/out using the device's eventMode, then the normal attendance rules apply.
 */

// ── Adapters ────────────────────────────────────────────────────────
// To add a device brand later, implement pull(device) returning raw punches and register it here.
export const ADAPTERS = {
    push_api: {
        label: 'Push API (device or middleware posts events)',
        pull: null,
    },
    csv_file: {
        label: 'Exported log file (CSV upload)',
        pull: null,
    },
    zkteco: {
        label: 'ZKTeco (TCP/UDP)',
        // Needs a protocol driver (e.g. the "zklib" family of packages) running on a machine that can
        // reach the device on the local network. Until it is installed, use push_api or csv_file.
        pull: async () => {
            throw ApiError.unprocessable('The ZKTeco adapter is not installed on this server yet. Use a push middleware or CSV log upload.');
        },
    },
    other: { label: 'Other', pull: null },
};

export const generateDeviceKey = () => {
    const key = `bio_${crypto.randomBytes(24).toString('base64url')}`;
    return { key, hash: crypto.createHash('sha256').update(key).digest('hex'), hint: `${key.slice(0, 8)}…${key.slice(-4)}` };
};

/** Finds the device for a push request authenticated by its X-Device-Key header. */
export const deviceFromKey = async (deviceCode, key) => {
    if (!deviceCode || !key) return null;
    const device = await BiometricDevice.findOne({ deviceCode: String(deviceCode).toUpperCase(), deletedAt: null }).select('+apiKeyHash');
    if (!device || !device.active || !device.apiKeyHash) return null;
    const hash = crypto.createHash('sha256').update(String(key)).digest('hex');
    const ok = hash.length === device.apiKeyHash.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(device.apiKeyHash));
    return ok ? device : null;
};

const normaliseType = (t) => {
    const v = String(t ?? '').toLowerCase();
    if (['in', 'checkin', 'check_in', '0', 'i'].includes(v)) return 'in';
    if (['out', 'checkout', 'check_out', '1', 'o'].includes(v)) return 'out';
    if (['break_out', '2'].includes(v)) return 'break_out';
    if (['break_in', '3'].includes(v)) return 'break_in';
    return 'unknown';
};

/** Stores raw punches. Duplicates (same device, user and timestamp) are ignored. */
export const ingestEvents = async (device, events, source = 'fingerprint') => {
    if (!Array.isArray(events) || !events.length) throw ApiError.unprocessable('No events supplied');
    if (events.length > 5000) throw ApiError.unprocessable('Send at most 5000 events per request');
    const mappings = await BiometricMapping.find({ status: 'active', deletedAt: null, $or: [{ device: device?._id || null }, { device: null }] }).lean();
    const byUser = new Map();
    mappings.forEach(m => { if (!byUser.has(m.biometricUserId) || m.device) byUser.set(m.biometricUserId, m.employee); });

    let stored = 0;
    let duplicates = 0;
    const rejected = [];
    for (const [i, e] of events.entries()) {
        const ts = new Date(e.timestamp);
        const userId = String(e.biometricUserId ?? e.userId ?? e.employeeId ?? '').trim();
        if (!userId || Number.isNaN(ts.getTime())) {
            rejected.push({ index: i, error: 'biometricUserId and a valid timestamp are required' });
            continue;
        }
        const employee = byUser.get(userId) || null;
        try {
            await AttendanceEvent.create({
                device: device?._id || null,
                employee,
                biometricUserId: userId,
                timestamp: ts,
                eventType: normaliseType(e.eventType ?? e.type ?? e.state),
                source,
                raw: e,
                status: employee ? 'pending' : 'error',
                error: employee ? '' : `No employee mapped to biometric user ${userId}`,
            });
            stored += 1;
        } catch (err) {
            if (err.code === 11000) duplicates += 1;
            else rejected.push({ index: i, error: err.message });
        }
    }
    if (device) {
        device.lastSyncAt = new Date();
        device.status = 'online';
        device.lastError = '';
        await device.save();
    }
    return { stored, duplicates, rejected };
};

/**
 * Converts pending punches into attendance. All punches of an employee's day are re-read so late
 * arriving events still produce the right first-in / last-out.
 */
export const processPendingEvents = async (req, { deviceId = null, limit = 5000 } = {}) => {
    const filter = { status: 'pending', employee: { $ne: null } };
    if (deviceId) filter.device = deviceId;
    const pending = await AttendanceEvent.find(filter).sort({ timestamp: 1 }).limit(limit).lean();
    const groups = new Map();
    for (const e of pending) {
        const key = `${e.employee}|${localDay(e.timestamp)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e._id);
    }
    const devices = new Map((await BiometricDevice.find({}).lean()).map(d => [String(d._id), d]));
    let created = 0;
    let errors = 0;
    for (const key of groups.keys()) {
        const [employee, day] = key.split('|');
        const dayStart = new Date(`${day}T00:00:00${process.env.HR_TZ_OFFSET || '+05:30'}`);
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        const all = await AttendanceEvent.find({ employee, timestamp: { $gte: dayStart, $lt: dayEnd }, status: { $in: ['pending', 'processed'] } }).sort({ timestamp: 1 });
        const device = devices.get(String(all[0]?.device)) || { eventMode: 'first_last', duplicateWindowMinutes: 2 };
        // Drop punches within the duplicate window of the previous punch.
        const windowMs = (device.duplicateWindowMinutes || 0) * 60000;
        const kept = [];
        for (const ev of all) {
            if (kept.length && ev.timestamp - kept[kept.length - 1].timestamp < windowMs && ev.eventType === kept[kept.length - 1].eventType) {
                if (ev.status === 'pending') { ev.status = 'duplicate'; ev.processedAt = new Date(); await ev.save(); }
                continue;
            }
            kept.push(ev);
        }
        let checkIn = null;
        let checkOut = null;
        if (device.eventMode === 'explicit') {
            checkIn = kept.find(e => e.eventType === 'in')?.timestamp || null;
            checkOut = [...kept].reverse().find(e => e.eventType === 'out')?.timestamp || null;
        } else {
            checkIn = kept[0]?.timestamp || null;
            checkOut = kept.length > 1 ? kept[kept.length - 1].timestamp : null;
        }
        try {
            const existing = await Attendance.findOne({ employee, date: day, deletedAt: null }).lean();
            if (existing && existing.source === 'manual') {
                throw new Error('A manual attendance record exists for this day; punches were kept but not applied');
            }
            if (existing?.leaveRequest) throw new Error('Employee is on approved leave this day');
            await upsertAttendance(req, {
                employee, date: day, checkIn, checkOut, remarks: `Biometric (${kept.length} punch${kept.length === 1 ? '' : 'es'}: ${kept.map(e => localTime(e.timestamp)).join(', ')})`,
            }, { overwrite: true, source: 'fingerprint' });
            await AttendanceEvent.updateMany({ _id: { $in: kept.map(e => e._id) }, status: 'pending' }, { status: 'processed', processedAt: new Date(), error: '' });
            created += 1;
        } catch (err) {
            errors += 1;
            await AttendanceEvent.updateMany({ _id: { $in: kept.map(e => e._id) }, status: 'pending' }, { status: err.statusCode ? 'error' : 'ignored', error: err.message, processedAt: new Date() });
        }
    }
    return { events: pending.length, days: groups.size, attendanceUpdated: created, errors };
};

/** Pull from a device through its adapter (when the adapter supports pulling). */
export const syncDevice = async (req, device) => {
    const adapter = ADAPTERS[device.protocol];
    if (!adapter?.pull) throw ApiError.unprocessable(`Devices using "${adapter?.label || device.protocol}" send data themselves; nothing to pull.`);
    try {
        const events = await adapter.pull(device);
        const ingest = await ingestEvents(device, events);
        const processed = await processPendingEvents(req, { deviceId: device._id });
        return { ...ingest, ...processed };
    } catch (err) {
        device.status = 'error';
        device.lastError = err.message;
        await device.save();
        throw err;
    }
};

/** Re-maps "error" events after a biometric ID mapping was added. */
export const remapUnmatchedEvents = async () => {
    const mappings = await BiometricMapping.find({ status: 'active', deletedAt: null }).lean();
    let fixed = 0;
    for (const m of mappings) {
        const res = await AttendanceEvent.updateMany(
            { biometricUserId: m.biometricUserId, employee: null, ...(m.device ? { device: m.device } : {}) },
            { employee: m.employee, status: 'pending', error: '' },
        );
        fixed += res.modifiedCount;
    }
    return fixed;
};
