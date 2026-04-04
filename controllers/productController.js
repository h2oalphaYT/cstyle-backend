import Product from '../models/Product.js';
import ProductImageDetail from '../models/ProductImageDetail.js';

/**
 * Product Controller
 * Handles all product-related operations
 */

// @desc    Get all products
// @route   GET /api/products
// @access  Public
export const getAllProducts = async (req, res) => {
    try {
        const { category, status, search, sortBy, limit, page, includeDeleted } = req.query;
        
        // Admin can request all products including deleted ones
        let query = includeDeleted === 'true' 
            ? {}   // no bDelete filter — return everything
            : {
                $or: [
                    { bDelete: false },
                    { bDelete: { $exists: false } }
                ]
            };

        // Filter by category
        if (category) {
            query.category = category;
        }

        // Filter by status
        if (status) {
            query.status = status;
        }

        // Search by name or product code
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { productCode: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        // Pagination
        const pageNum = parseInt(page) || 1;
        const limitNum = parseInt(limit) || 50;
        const skip = (pageNum - 1) * limitNum;

        // Sorting
        let sortOptions = { createdAt: -1 }; // Default: newest first
        if (sortBy === 'name') sortOptions = { name: 1 };
        if (sortBy === 'price-asc') sortOptions = { price: 1 };
        if (sortBy === 'price-desc') sortOptions = { price: -1 };
        if (sortBy === 'stock') sortOptions = { totalStock: -1 };

        // Execute query
        const products = await Product.find(query)
            .populate('images')
            .sort(sortOptions)
            .skip(skip)
            .limit(limitNum);

        // Get total count for pagination
        const total = await Product.countDocuments(query);

        res.set('Cache-Control', 'no-store');
        res.json({
            success: true,
            data: products,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });
    } catch (error) {
        console.error('Get all products error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch products',
            error: error.message
        });
    }
};

// @desc    Get single product by product code
// @route   GET /api/products/:productCode
// @access  Public
export const getProductByCode = async (req, res) => {
    try {
        const product = await Product.findOne({
            productCode: req.params.productCode,
            $or: [
                { bDelete: false },
                { bDelete: { $exists: false } }
            ]
        })
            .populate('images');

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        res.json({
            success: true,
            data: product
        });
    } catch (error) {
        console.error('Get product error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch product',
            error: error.message
        });
    }
};

// @desc    Create new product
// @route   POST /api/products
// @access  Private/Admin
export const createProduct = async (req, res) => {
    try {
        const {
            productCode,
            name,
            description,
            category,
            subcategory,
            price,
            discount,
            primaryImage,
            colors,
            sizes,
            variantStock,
            isActive,
            images,
            features,
            material
        } = req.body;

        // Validate required fields
        if (!productCode) {
            return res.status(400).json({
                success: false,
                message: 'Product code is required'
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: 'Product name is required'
            });
        }

        if (!category) {
            return res.status(400).json({
                success: false,
                message: 'Category is required'
            });
        }

        if (!price || price <= 0) {
            return res.status(400).json({
                success: false,
                message: 'Valid price is required'
            });
        }

        // Check if product code already exists
        const existingProduct = await Product.findOne({ productCode });
        if (existingProduct) {
            return res.status(400).json({
                success: false,
                message: 'Product code already exists'
            });
        }

        // Prepare product data
        const productData = {
            productCode: productCode.toUpperCase(),
            name: name.trim(),
            description: description || '',
            category,
            subcategory,
            price,
            discount: discount || 0,
            primaryImage: primaryImage || 'https://via.placeholder.com/400',
            colors: colors || [],
            sizes: sizes || [],
            variantStock: variantStock || [],
            status: isActive ? 'active' : 'inactive',
            features: features || [],
            material: material || ''
        };

        // Calculate original price if discount exists
        if (discount > 0) {
            productData.originalPrice = price;
        }

        // Create product
        const product = new Product(productData);
        await product.save();

        // Create image details if provided
        if (images && images.length > 0) {
            const imageDocuments = images.map((img, index) => ({
                productCode: product.productCode,
                imageUrl: img.imageUrl || img,
                imageOrder: img.imageOrder || index,
                altText: img.altText || product.name,
                isPrimary: img.isPrimary || index === 0,
                imageType: img.imageType || 'product'
            }));

            await ProductImageDetail.insertMany(imageDocuments);
        }

        // Fetch product with populated images
        const populatedProduct = await Product.findOne({ productCode: product.productCode })
            .populate('images');

        console.log('✅ Product created successfully:', populatedProduct.productCode);

        res.status(201).json({
            success: true,
            message: 'Product created successfully',
            data: populatedProduct
        });
    } catch (error) {
        console.error('Create product error:', error);

        // Handle duplicate key error
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Product with this code already exists'
            });
        }

        // Handle validation errors
        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: messages
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to create product',
            error: error.message
        });
    }
};

// @desc    Update product
// @route   PUT /api/products/:productCode
// @access  Private/Admin
export const updateProduct = async (req, res) => {
    try {
        const { images, productCode: bodyProductCode, ...productData } = req.body;

        // Use URL param first, fall back to body productCode
        const targetCode = (req.params.productCode || bodyProductCode || '').toUpperCase();

        if (!targetCode) {
            return res.status(400).json({
                success: false,
                message: 'Product code is required (in URL or body)'
            });
        }

        // Convert isActive to status (legacy support)
        if (productData.hasOwnProperty('isActive')) {
            productData.status = productData.isActive ? 'active' : 'inactive';
            delete productData.isActive;
        }

        console.log(`📝 Updating product: ${targetCode}`, productData);

        // Update product
        const product = await Product.findOneAndUpdate(
            { 
                productCode: targetCode,
                bDelete: false
            },
            productData,
            { new: true, runValidators: true }
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Update images if provided
        if (images && images.length > 0) {
            // Delete existing images
            await ProductImageDetail.deleteMany({ productCode: product.productCode });

            // Create new images
            const imageDocuments = images.map((img, index) => ({
                productCode: product.productCode,
                imageUrl: img.imageUrl || img,
                imageOrder: img.imageOrder || index,
                altText: img.altText || product.name,
                isPrimary: img.isPrimary || index === 0,
                imageType: img.imageType || 'product'
            }));

            await ProductImageDetail.insertMany(imageDocuments);
        }

        // Fetch updated product with images
        const populatedProduct = await Product.findOne({ productCode: product.productCode })
            .populate('images');

        console.log('✅ Product updated successfully:', populatedProduct.productCode);

        res.json({
            success: true,
            message: 'Product updated successfully',
            data: populatedProduct
        });
    } catch (error) {
        console.error('Update product error:', error);

        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: 'Validation failed',
                errors: messages
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to update product',
            error: error.message
        });
    }
};

// @desc    Delete product (Soft Delete)
// @route   DELETE /api/products/:productCode
// @access  Private/Admin
export const deleteProduct = async (req, res) => {
    try {
        // Soft delete: Set bDelete to true instead of removing from database
        const product = await Product.findOneAndUpdate(
            { 
                productCode: req.params.productCode,
                bDelete: false  // Only delete if not already deleted
            },
            { 
                bDelete: true,
                status: 'inactive'  // Also set status to inactive
            },
            { new: true }
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or already deleted'
            });
        }

        console.log('✅ Product soft deleted successfully:', req.params.productCode);

        res.json({
            success: true,
            message: 'Product deleted successfully'
        });
    } catch (error) {
        console.error('Delete product error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete product',
            error: error.message
        });
    }
};

// @desc    Restore soft-deleted product
// @route   PATCH /api/products/:productCode/restore
// @access  Private/Admin
export const restoreProduct = async (req, res) => {
    try {
        const product = await Product.findOneAndUpdate(
            {
                productCode: req.params.productCode,
                bDelete: true   // Only restore if already deleted
            },
            {
                bDelete: false,
                status: 'active'
            },
            { new: true }
        );

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found or is not deleted'
            });
        }

        console.log('✅ Product restored successfully:', req.params.productCode);

        res.json({
            success: true,
            message: 'Product restored successfully',
            data: product
        });
    } catch (error) {
        console.error('Restore product error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to restore product',
            error: error.message
        });
    }
};

// @desc    Update product stock
// @route   PATCH /api/products/:productCode/stock
// @access  Private/Admin
export const updateProductStock = async (req, res) => {
    try {
        const { variantStock } = req.body;

        if (!variantStock || !Array.isArray(variantStock)) {
            return res.status(400).json({
                success: false,
                message: 'Valid variant stock array is required'
            });
        }

        const product = await Product.findOne({ 
            productCode: req.params.productCode,
            bDelete: false  // Only update stock for non-deleted products
        });

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        // Update variant stock
        product.variantStock = variantStock;
        await product.save(); // This will trigger pre-save to calculate totalStock

        console.log('✅ Product stock updated:', product.productCode, 'Total:', product.totalStock);

        res.json({
            success: true,
            message: 'Stock updated successfully',
            data: product
        });
    } catch (error) {
        console.error('Update stock error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update stock',
            error: error.message
        });
    }
};

// @desc    Get product images
// @route   GET /api/products/:productCode/images
// @access  Public
export const getProductImages = async (req, res) => {
    try {
        const images = await ProductImageDetail.find({
            productCode: req.params.productCode
        }).sort({ imageOrder: 1 });

        res.json({
            success: true,
            data: images
        });
    } catch (error) {
        console.error('Get images error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch images',
            error: error.message
        });
    }
};

// @desc    Add image to product
// @route   POST /api/products/:productCode/images
// @access  Private/Admin
export const addProductImage = async (req, res) => {
    try {
        const { imageUrl, imageOrder, altText, isPrimary, imageType } = req.body;

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Image URL is required'
            });
        }

        const product = await Product.findOne({ 
            productCode: req.params.productCode,
            bDelete: false  // Only add images to non-deleted products
        });

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        const imageDetail = new ProductImageDetail({
            productCode: req.params.productCode,
            imageUrl,
            imageOrder,
            altText: altText || product.name,
            isPrimary: isPrimary || false,
            imageType: imageType || 'product'
        });

        await imageDetail.save();

        console.log('✅ Image added to product:', req.params.productCode);

        res.status(201).json({
            success: true,
            message: 'Image added successfully',
            data: imageDetail
        });
    } catch (error) {
        console.error('Add image error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add image',
            error: error.message
        });
    }
};

// @desc    Delete product image
// @route   DELETE /api/products/:productCode/images/:imageId
// @access  Private/Admin
export const deleteProductImage = async (req, res) => {
    try {
        const image = await ProductImageDetail.findOneAndDelete({
            _id: req.params.imageId,
            productCode: req.params.productCode
        });

        if (!image) {
            return res.status(404).json({
                success: false,
                message: 'Image not found'
            });
        }

        console.log('✅ Image deleted from product:', req.params.productCode);

        res.json({
            success: true,
            message: 'Image deleted successfully'
        });
    } catch (error) {
        console.error('Delete image error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete image',
            error: error.message
        });
    }
};

// @desc    Get low stock products
// @route   GET /api/products/alerts/low-stock
// @access  Private/Admin
export const getLowStockProducts = async (req, res) => {
    try {
        const products = await Product.find({
            $or: [
                { bDelete: false },
                { bDelete: { $exists: false } }
            ],
            $expr: { $lte: ['$totalStock', '$lowStockThreshold'] }
        }).sort({ totalStock: 1 });

        res.json({
            success: true,
            data: products,
            count: products.length
        });
    } catch (error) {
        console.error('Get low stock error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch low stock products',
            error: error.message
        });
    }
};
