import express from 'express';
import Product from '../models/Product.js';

const router = express.Router();

// Get inventory summary
router.get('/summary', async (req, res) => {
    try {
        const products = await Product.find({ status: 'active' });
        
        const totalProducts = products.length;
        const totalStock = products.reduce((sum, p) => sum + p.totalStock, 0);
        const lowStockProducts = products.filter(p => p.totalStock <= p.lowStockThreshold);
        
        const categories = [...new Set(products.map(p => p.category))];

        res.json({
            success: true,
            data: {
                totalProducts,
                totalStock,
                lowStockCount: lowStockProducts.length,
                lowStockProducts: lowStockProducts.map(p => ({
                    id: p.id,
                    name: p.name,
                    stock: p.totalStock
                })),
                categories: categories.length
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get product inventory details
router.get('/products', async (req, res) => {
    try {
        const { category, lowStock } = req.query;
        let query = { status: 'active' };

        if (category) query.category = category;

        const products = await Product.find(query).select(
            'id name category image totalStock colors sizes variantStock lowStockThreshold'
        );

        let filteredProducts = products;
        if (lowStock === 'true') {
            filteredProducts = products.filter(p => p.totalStock <= p.lowStockThreshold);
        }

        res.json({ success: true, data: filteredProducts });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Update variant stock
router.patch('/products/:id/variants', async (req, res) => {
    try {
        const { variantStock } = req.body;
        
        // Calculate total stock from variant stock
        const totalStock = variantStock.reduce((sum, v) => sum + v.quantity, 0);
        
        const product = await Product.findOneAndUpdate(
            { id: req.params.id },
            { variantStock, totalStock },
            { new: true }
        );

        if (!product) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }

        res.json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
});

export default router;
