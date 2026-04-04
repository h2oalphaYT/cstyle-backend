# CStyle E-commerce Database Models

## Models Overview

### 1. Product Model
Main product information with embedded color variants and stock management.

**File:** `models/Product.js`

**Fields:**
- `productCode` (String, Required, Unique) - Unique product identifier (e.g., "PRD001")
- `name` (String, Required) - Product name
- `description` (String, Required) - Product description
- `category` (String, Required) - Enum: ['Men', 'Women', 'Kids']
- `subcategory` (String) - Product subcategory
- `price` (Number, Required) - Product price
- `originalPrice` (Number) - Original price before discount
- `discount` (Number, 0-100) - Discount percentage
- `primaryImage` (String, Required) - Main product image URL
- `colors` (Array of ColorVariant) - Available color options
- `sizes` (Array of String) - Available sizes
- `variantStock` (Array of VariantStock) - Stock by color and size
- `totalStock` (Number) - Auto-calculated total stock
- `lowStockThreshold` (Number) - Alert threshold for low stock
- `status` (String) - Enum: ['active', 'inactive']
- `features` (Array of String) - Product features
- `material` (String) - Product material
- `rating` (Number, 0-5) - Product rating
- `reviews` (Number) - Number of reviews
- `inStock` (Boolean) - Auto-calculated availability
- `newArrival` (Boolean) - New arrival flag
- `isFeatured` (Boolean) - Featured product flag
- `isTrending` (Boolean) - Trending product flag

**Embedded Schemas:**

**ColorVariant:**
```javascript
{
    color: String,        // Color name
    colorCode: String,    // Hex color code
    colorName: String     // Display name
}
```

**VariantStock:**
```javascript
{
    color: String,        // Color name
    colorCode: String,    // Hex color code
    size: String,         // Size (S, M, L, XL, etc.)
    quantity: Number      // Available quantity
}
```

**Virtual Fields:**
- `images` - Populated from ProductImageDetail model
- `finalPrice` - Calculated discounted price
- `stockStatus` - Calculated: 'out_of_stock', 'low_stock', 'in_stock'

**Middleware:**
- Pre-save: Auto-calculates `totalStock` from `variantStock`
- Pre-save: Updates `inStock` based on `totalStock`

---

### 2. ProductImageDetail Model
Manages multiple images for each product.

**File:** `models/ProductImageDetail.js`

**Fields:**
- `productCode` (String, Required, Indexed) - Links to Product
- `imageUrl` (String, Required) - Image URL
- `imageOrder` (Number) - Display order (0, 1, 2...)
- `altText` (String) - Alt text for accessibility
- `isPrimary` (Boolean) - Primary image flag
- `imageType` (String) - Enum: ['product', 'variant', 'detail', 'lifestyle']

**Features:**
- Automatically ensures only one primary image per product
- Ordered by `imageOrder` for display
- Supports multiple image types for different views

---

## API Endpoints

### Products

**GET /api/products**
- Get all products with images
- Query params: `category`, `status`, `search`

**GET /api/products/:productCode**
- Get single product with all images

**POST /api/products**
- Create new product with images
- Body: Product data + images array

**PUT /api/products/:productCode**
- Update product and images

**DELETE /api/products/:productCode**
- Delete product and all associated images

**PATCH /api/products/:productCode/stock**
- Update variant stock
- Body: `{ variantStock: [...] }`

### Product Images

**GET /api/products/:productCode/images**
- Get all images for a product

**POST /api/products/:productCode/images**
- Add new image to product
- Body: `{ imageUrl, imageOrder, altText, isPrimary, imageType }`

**DELETE /api/products/:productCode/images/:imageId**
- Delete specific image

---

## Usage Examples

### 1. Create Product with Multiple Images

```javascript
POST /api/products

{
  "productCode": "PRD001",
  "name": "Classic Black Shirt",
  "description": "Premium cotton shirt",
  "category": "Men",
  "subcategory": "Shirts",
  "price": 3500,
  "originalPrice": 4000,
  "discount": 12.5,
  "primaryImage": "https://example.com/images/shirt-main.jpg",
  "colors": [
    {
      "color": "Black",
      "colorCode": "#000000",
      "colorName": "Black"
    },
    {
      "color": "White",
      "colorCode": "#FFFFFF",
      "colorName": "White"
    }
  ],
  "sizes": ["S", "M", "L", "XL"],
  "variantStock": [
    {
      "color": "Black",
      "colorCode": "#000000",
      "size": "M",
      "quantity": 25
    },
    {
      "color": "White",
      "colorCode": "#FFFFFF",
      "size": "L",
      "quantity": 15
    }
  ],
  "features": ["100% Cotton", "Machine Washable"],
  "material": "Cotton",
  "status": "active",
  "isFeatured": true,
  "images": [
    {
      "imageUrl": "https://example.com/images/shirt-1.jpg",
      "imageOrder": 0,
      "isPrimary": true,
      "imageType": "product"
    },
    {
      "imageUrl": "https://example.com/images/shirt-2.jpg",
      "imageOrder": 1,
      "imageType": "variant"
    },
    {
      "imageUrl": "https://example.com/images/shirt-3.jpg",
      "imageOrder": 2,
      "imageType": "detail"
    }
  ]
}
```

### 2. Update Stock

```javascript
PATCH /api/products/PRD001/stock

{
  "variantStock": [
    {
      "color": "Black",
      "colorCode": "#000000",
      "size": "M",
      "quantity": 30
    },
    {
      "color": "White",
      "colorCode": "#FFFFFF",
      "size": "L",
      "quantity": 20
    }
  ]
}
```

### 3. Add New Image

```javascript
POST /api/products/PRD001/images

{
  "imageUrl": "https://example.com/images/shirt-lifestyle.jpg",
  "imageOrder": 3,
  "altText": "Model wearing black shirt",
  "imageType": "lifestyle"
}
```

---

## Frontend Integration

### Using Product Service

```typescript
import productService from '@/services/productService';

// Get all products
const { data: products } = await productService.getAll({ category: 'Men' });

// Get single product
const { data: product } = await productService.getByCode('PRD001');

// Create product
const newProduct = await productService.create({
  productCode: 'PRD002',
  name: 'Summer Dress',
  description: 'Light and breezy',
  category: 'Women',
  price: 4500,
  primaryImage: 'https://example.com/dress.jpg',
  images: [
    { imageUrl: 'https://example.com/dress-1.jpg', imageOrder: 0 }
  ]
});

// Update stock
await productService.updateStock('PRD001', [
  { color: 'Black', colorCode: '#000000', size: 'M', quantity: 50 }
]);

// Delete product
await productService.delete('PRD001');
```

---

## Database Relationships

```
Product (1) ──────── (Many) ProductImageDetail
   │
   └─ productCode ────> productCode (indexed)
```

**Key Points:**
- One product can have multiple images
- Images are linked via `productCode`
- Virtual populate automatically loads images with product
- Deleting a product cascades to delete all images
- Only one image can be primary per product

---

## Indexes

**Product Model:**
- `productCode` (unique)
- `category` + `status`
- `status` + `createdAt`
- Text index on `name` + `description`

**ProductImageDetail Model:**
- `productCode` + `imageOrder`
- `productCode` + `isPrimary`

These indexes optimize common queries and ensure fast lookups.
