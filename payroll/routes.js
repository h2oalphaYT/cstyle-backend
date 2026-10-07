import express from 'express';
import setupRoutes from './controllers/setupRoutes.js';
import employeeRoutes from './controllers/employeeRoutes.js';
import attendanceRoutes from './controllers/attendanceRoutes.js';
import financeRoutes from './controllers/financeRoutes.js';
import payrollRoutes from './controllers/payrollRoutes.js';
import productionRoutes from './controllers/productionRoutes.js';

/** Payroll & HR module. Mounted under /api by routes/index.js. */
const router = express.Router();
router.use(setupRoutes);
router.use(employeeRoutes);
router.use(attendanceRoutes);
router.use(financeRoutes);
router.use(payrollRoutes);
router.use(productionRoutes);

export default router;
