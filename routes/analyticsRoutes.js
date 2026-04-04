import express from 'express';
import Order from '../models/Order.js';
import Product from '../models/Product.js';
import Customer from '../models/Customer.js';

const router = express.Router();

// Get dashboard analytics
router.get('/dashboard', async (req, res) => {
    try {
        const { timeRange = 'week' } = req.query;
        
        // Calculate date range
        const now = new Date();
        let startDate;
        switch (timeRange) {
            case 'day':
                startDate = new Date(now.setDate(now.getDate() - 1));
                break;
            case 'week':
                startDate = new Date(now.setDate(now.getDate() - 7));
                break;
            case 'month':
                startDate = new Date(now.setMonth(now.getMonth() - 1));
                break;
            default:
                startDate = new Date(now.setDate(now.getDate() - 7));
        }

        // Get orders in date range
        const orders = await Order.find({
            createdAt: { $gte: startDate }
        });

        const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0);
        const totalOrders = orders.length;
        
        const completedOrders = orders.filter(o => o.status === 'completed').length;
        const pendingOrders = orders.filter(o => o.status === 'pending').length;

        // Get total products and customers
        const totalProducts = await Product.countDocuments({ status: 'active' });
        const totalCustomers = await Customer.countDocuments({ status: 'active' });

        // Get top selling products
        const productSales = {};
        orders.forEach(order => {
            order.items.forEach(item => {
                const key = item.productId.toString();
                if (!productSales[key]) {
                    productSales[key] = {
                        productId: item.productId,
                        name: item.productName,
                        sales: 0,
                        revenue: 0
                    };
                }
                productSales[key].sales += item.quantity;
                productSales[key].revenue += item.price * item.quantity;
            });
        });

        const topProducts = Object.values(productSales)
            .sort((a, b) => b.sales - a.sales)
            .slice(0, 5);

        res.json({
            success: true,
            data: {
                revenue: {
                    total: totalRevenue,
                    change: 18.7 // Mock change percentage
                },
                orders: {
                    total: totalOrders,
                    completed: completedOrders,
                    pending: pendingOrders
                },
                products: {
                    total: totalProducts
                },
                customers: {
                    total: totalCustomers
                },
                topProducts
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get sales data for charts
router.get('/sales', async (req, res) => {
    try {
        const { timeRange = 'week' } = req.query;
        
        // TODO: Implement detailed sales data aggregation
        res.json({
            success: true,
            data: []
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

export default router;
