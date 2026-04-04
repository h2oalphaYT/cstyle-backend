import express from 'express';
import {
    getAllProducts,
    getProductByCode,
    createProduct,
    updateProduct,
    deleteProduct,
    restoreProduct,
    updateProductStock,
    getProductImages,
    addProductImage,
    deleteProductImage,
    getLowStockProducts
} from '../controllers/productController.js';

const router = express.Router();

// Product routes
router.get('/', getAllProducts);
router.post('/', createProduct);
router.get('/alerts/low-stock', getLowStockProducts);
router.get('/:productCode', getProductByCode);
router.put('/:productCode', updateProduct);
router.delete('/:productCode', deleteProduct);

// Stock management
router.patch('/:productCode/stock', updateProductStock);
router.patch('/:productCode/restore', restoreProduct);

// Image management
router.get('/:productCode/images', getProductImages);
router.post('/:productCode/images', addProductImage);
router.delete('/:productCode/images/:imageId', deleteProductImage);

export default router;
