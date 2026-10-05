import { Employee } from '../models/index.js';
import { loadAccess } from '../permissions.js';

/**
 * Employee ids the current user may see, based on the role's data scope:
 *   all → no restriction (returns null), department → same department, team → direct reports + self, own → self.
 */
export const allowedEmployeeIds = async (req) => {
    const access = await loadAccess(req);
    if (access.dataScope === 'all') return null;
    const self = req.user.employee ? await Employee.findById(req.user.employee).select('department').lean() : null;
    if (!self) return [];
    if (access.dataScope === 'department' && self.department) {
        return (await Employee.find({ department: self.department, deletedAt: null }).select('_id').lean()).map(e => e._id);
    }
    if (access.dataScope === 'team') {
        const team = await Employee.find({ manager: self._id, deletedAt: null }).select('_id').lean();
        return [self._id, ...team.map(e => e._id)];
    }
    return [self._id];
};

/** Adds an employee restriction to a Mongo filter (field defaults to "employee"). */
export const scopeFilter = async (req, filter = {}, field = 'employee') => {
    const ids = await allowedEmployeeIds(req);
    if (ids === null) return filter;
    return { ...filter, $and: [...(filter.$and || []), { [field]: { $in: ids } }] };
};

export const canSeeEmployee = async (req, employeeId) => {
    const ids = await allowedEmployeeIds(req);
    return ids === null || ids.some(id => String(id) === String(employeeId));
};
