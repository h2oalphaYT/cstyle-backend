# CStyle E-commerce Backend API

Backend API for CStyle E-commerce Admin Panel built with Node.js, Express, and MongoDB.

## 🚀 Quick Start

### Prerequisites
- Node.js (v18 or higher)
- MongoDB Atlas account or local MongoDB
- npm or yarn

### Installation

1. Navigate to backend folder:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
- Copy `.env.example` to `.env`
- Update the MongoDB connection string with your password:
```
MONGODB_URI=mongodb+srv://cstyle:YOUR_PASSWORD@cluster0.opigyca.mongodb.net/cstyle?retryWrites=true&w=majority&appName=Cluster0
```

4. Start the development server:
```bash
npm run dev
```

The API will be running at `http://localhost:5000`

## 📁 Project Structure

```
backend/
├── config/
│   └── database.js       # MongoDB connection
├── models/
│   ├── Product.js        # Product schema
│   ├── Order.js          # Order schema
│   └── Customer.js       # Customer schema
├── routes/
│   ├── productRoutes.js  # Product endpoints
│   ├── orderRoutes.js    # Order endpoints
│   ├── customerRoutes.js # Customer endpoints
│   ├── inventoryRoutes.js # Inventory endpoints
│   ├── authRoutes.js     # Authentication endpoints
│   └── analyticsRoutes.js # Analytics endpoints
├── .env                  # Environment variables
├── .env.example          # Example environment file
├── server.js             # Main server file
└── package.json
```

## 🛣️ API Endpoints

### Products
- `GET /api/products` - Get all products
- `GET /api/products/:id` - Get single product
- `POST /api/products` - Create product
- `PUT /api/products/:id` - Update product
- `DELETE /api/products/:id` - Delete product
- `PATCH /api/products/:id/stock` - Update stock

### Orders
- `GET /api/orders` - Get all orders
- `GET /api/orders/:orderId` - Get single order
- `POST /api/orders` - Create order
- `PATCH /api/orders/:orderId/status` - Update order status
- `DELETE /api/orders/:orderId` - Delete order

### Customers
- `GET /api/customers` - Get all customers
- `GET /api/customers/:id` - Get single customer
- `POST /api/customers` - Create customer
- `PUT /api/customers/:id` - Update customer
- `DELETE /api/customers/:id` - Delete customer

### Inventory
- `GET /api/inventory/summary` - Get inventory summary
- `GET /api/inventory/products` - Get products inventory
- `PATCH /api/inventory/products/:id/variants` - Update variant stock

### Analytics
- `GET /api/analytics/dashboard` - Get dashboard analytics
- `GET /api/analytics/sales` - Get sales data

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration

## 🔧 Environment Variables

| Variable | Description |
|----------|-------------|
| `MONGODB_URI` | MongoDB connection string |
| `PORT` | Server port (default: 5000) |
| `NODE_ENV` | Environment (development/production) |
| `JWT_SECRET` | Secret key for JWT tokens |
| `FRONTEND_URL` | Frontend URL for CORS |

## 📦 Dependencies

- **express** - Web framework
- **mongoose** - MongoDB ODM
- **cors** - Enable CORS
- **dotenv** - Environment variables
- **bcryptjs** - Password hashing
- **jsonwebtoken** - JWT authentication
- **multer** - File uploads

## 🔐 Security Notes

1. Change the `JWT_SECRET` in `.env` to a secure random string
2. Never commit the `.env` file to version control
3. Use HTTPS in production
4. Implement proper authentication middleware
5. Validate and sanitize all inputs

## 🚀 Deployment

For production deployment:
1. Set `NODE_ENV=production`
2. Use a secure JWT secret
3. Enable MongoDB IP whitelist
4. Use environment variables for all sensitive data
5. Implement rate limiting and security headers

## 📝 License

ISC
