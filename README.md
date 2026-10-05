# CStyle — Backend API

REST API for the CStyle e-commerce store (storefront + admin panel), built with **Node.js, Express and MongoDB (Mongoose)**.
The storefront lives in the sibling repository `cstyle-frontend`.

```
                    ┌──────────────────┐
                    │     FRONTEND     │  React + Vite (cstyle-frontend)
                    │ CStyle Storefront│  storefront + /admin
                    └────────┬─────────┘
                         REST API (JWT)
                    ┌────────▼─────────┐
                    │     BACKEND      │  Express (this repo)
                    └───────┬──────────┘
             ┌──────────────┴──────────────┐
       ┌─────▼─────┐                 ┌─────▼─────┐
       │  MongoDB  │                 │  uploads/ │  WebP images served at /uploads
       └───────────┘                 └───────────┘
```

## Quick start

```bash
npm install
cp .env.example .env        # then edit .env (see below)
npm run db:local            # optional: local MongoDB in ./.mongo-data (separate terminal)
npm run seed                # admin, customer, categories, 18 products + images, coupons, banners
npm run dev                 # API on http://localhost:5000 (auto-restarts)
npm test                    # end-to-end API checks against the running server
```

Requires Node.js 18.18+.

| Script | What it does |
| --- | --- |
| `npm run dev` | Start with nodemon |
| `npm start` | Start for production |
| `npm run seed` | Create sample data. Safe to re-run: existing records (matched by slug / SKU / code / email) are left alone |
| `npm run seed:fresh` | Wipe catalog, orders, carts, wishlists, reviews, coupons and banners, then seed. Refuses to run when `NODE_ENV=production` |
| `npm run db:local` | Run a local MongoDB without installing it (downloads the official MongoDB binary once, keeps data in `.mongo-data/`) |
| `npm test` | API end-to-end tests (`tests/api.test.js`); needs a running, seeded server |
| `npm run migrate` | Payroll & HR setup: indexes, built-in roles, settings, leave/OT types, salary components and sample structures. Idempotent (`--update-roles` refreshes built-in role permissions) |
| `npm run payroll:demo` | Demo company with employees DEMO-A…E and January 2025 attendance (`npm run payroll:demo -- --reset` recreates it) |
| `npm run test:payroll` | Payroll end-to-end tests; needs a running server after `migrate` |

## Environment (`.env`)

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Connection string. Local: `mongodb://127.0.0.1:27017/cstyle`. Atlas: `mongodb+srv://user:pass@cluster.mongodb.net/cstyle?retryWrites=true&w=majority` |
| `MONGODB_DB_NAME` | Optional database name override |
| `JWT_SECRET` | Signs login tokens. Required; at least 32 chars in production |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`) |
| `FRONTEND_URL` | Allowed CORS origins, comma separated |
| `API_BASE_URL` | Public URL of this API; used to build absolute image URLs |
| `UPLOAD_DIR` | Where images are stored (default `uploads`) |
| `MAX_FILE_SIZE` | Max upload size in bytes (default 5 MB) |
| `CURRENCY`, `SHIPPING_FEE`, `FREE_SHIPPING_THRESHOLD` | Store pricing rules (LKR) |
| `SEED_ADMIN_*`, `SEED_CUSTOMER_*` | Accounts created by `npm run seed` |
| `HR_TZ_OFFSET` | Time zone for attendance days (default `+05:30`) |
| `HR_FILES_DIR`, `HR_MAX_FILE_SIZE` | Private HR document storage (default `private_files/hr`, 10 MB) |
| `DEMO_STAFF_PASSWORD` | Password for demo staff logins (development only) |

### MongoDB setup

* **Local:** `npm run db:local` (no install needed), or install MongoDB Community and use `mongodb://127.0.0.1:27017/cstyle`.
* **Atlas:** create a cluster, add a database user, allow your IP (or `0.0.0.0/0` for hosted backends) under *Network Access*, then paste the `mongodb+srv://…` string into `MONGODB_URI`. Indexes are created automatically on start-up.

## Payroll & HR

The payroll, HR and attendance module lives in `payroll/` and is documented in [docs/PAYROLL.md](docs/PAYROLL.md).

## Project structure

```
config/        env.js (validated settings), database.js
controllers/   auth, products, catalog (categories & banners), reviews, uploads, cart & wishlist, orders, admin, inbox
middleware/    auth (JWT, roles), validate (zod), sanitize (NoSQL injection), error (consistent JSON errors)
models/        User, Product, Category, Cart, Wishlist, Order, Coupon, Review, Banner, Counter, Inbox (contact + newsletter)
routes/        index.js — every endpoint in one place
services/      imageService (multer + sharp), pricingService (server-side totals, coupons), inventoryService (atomic stock)
validators/    zod request schemas
scripts/       seed.js, sampleImages.js (generated garment images), db-local.js
tests/         api.test.js
uploads/       products/ categories/ banners/  (created automatically, git-ignored)
```

## Image uploads and storage

1. The admin uploads JPG / JPEG / PNG / WEBP files to `/api/uploads/*` (admin token required).
2. Multer keeps the file in memory and checks the MIME type, extension and size (`MAX_FILE_SIZE`).
3. Sharp verifies the bytes really are an image, auto-rotates, resizes (max 1600×2000 for products), strips metadata and saves **WebP**.
4. Files get safe generated names — the original file name is never used:
   `uploads/products/product-68f23a91-main.webp`, `product-68f23a91-1.webp`, `…-2.webp`
5. MongoDB stores the server-relative path (`/uploads/products/…`). Every API response converts it into a full URL using `API_BASE_URL`, e.g. `http://localhost:5000/uploads/products/product-68f23a91-1.webp`. Changing domains only needs an `.env` change.
6. Images are served by Express at `GET /uploads/<folder>/<file>`. Images removed from a product (or replaced on a category/banner) are deleted from disk when no other product uses them.

Seed images are generated by `scripts/sampleImages.js` and go through the same pipeline, e.g. `uploads/products/cs-sh-001-01.webp`.

**Production note:** the local `uploads/` folder must be on persistent storage (a mounted volume on Railway/Render, or a VPS disk). For serverless/ephemeral hosts, swap `processAndStoreImage` / `deleteStoredImage` in `services/imageService.js` for an object store such as S3 or Cloudinary.

## API

All responses are JSON: `{ "success": true, "data": …, "pagination"?: { page, limit, total, totalPages } }` or
`{ "success": false, "message": "…", "errors"?: [{ field, message }] }` with status 400 / 401 / 403 / 404 / 409 / 413 / 422 / 500.
Authenticated requests send `Authorization: Bearer <token>`.

### Auth
| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/auth/register` | public — `{ name, email, password, phone? }` → `{ token, user }` |
| POST | `/api/auth/login` | public — `{ email, password }` → `{ token, user }` |
| POST | `/api/auth/logout` | user — revokes all of the user's tokens |
| GET / PUT | `/api/auth/me` | user — profile, phone, addresses |
| PUT | `/api/auth/password` | user — `{ currentPassword, newPassword }` |

### Products
| Method | Path | Access |
| --- | --- | --- |
| GET | `/api/products` | public — query: `page, limit (≤100), search, category (slug/name/id), subCategory, gender, minPrice, maxPrice, size, color, tag, featured, newArrival, onSale, inStock, lowStock, ids, exclude, sort` (`newest, oldest, price-asc, price-desc, name, rating, popular, best-selling, stock`). Admins may add `status=active|inactive|deleted|all` |
| GET | `/api/products/suggestions?q=` | public — search suggestions |
| GET | `/api/products/:id` | public — id or slug |
| GET | `/api/products/slug/:slug` | public |
| GET | `/api/products/:id/related` | public |
| POST | `/api/products/:id/view` | public — view count + recently viewed for logged-in users |
| GET / POST | `/api/products/:id/reviews` | public / user |
| DELETE | `/api/reviews/:reviewId` | author or admin |
| POST | `/api/products` | admin |
| PUT | `/api/products/:id` | admin (partial updates allowed) |
| PATCH | `/api/products/:id/status` | admin — `{ active }` |
| PATCH | `/api/products/:id/thumbnail` | admin — `{ url }` sets the primary image |
| DELETE | `/api/products/:id/images` | admin — `{ url }` removes one image |
| DELETE | `/api/products/:id` | admin — soft delete |
| PATCH | `/api/products/:id/restore` | admin |

Product responses include `images` (full URLs), `thumbnail`, `price`, `salePrice`, `finalPrice`, `onSale`, `discountPercent`, `stock`, `stockStatus`, `variants [{ _id, sku, size, color, stock }]`, `colors [{ name, hex }]`, `sizes`, `specifications`, `tags`, `ratingAverage`, `ratingCount`, `category { name, slug }`.

### Uploads (admin)
| Method | Path | Body (multipart) |
| --- | --- | --- |
| POST | `/api/uploads/product` | `image` — one file (thumbnail) |
| POST | `/api/uploads/products` | `images` — up to 10 files |
| POST | `/api/uploads/category` | `image` |
| POST | `/api/uploads/banner` | `image` |

Returns `{ url, path, filename, width, height, size }` (or an array).

### Catalog
`GET /api/categories` (with product counts), `GET /api/categories/:idOrSlug`, `POST|PUT|DELETE /api/categories/:id` (admin) ·
`GET /api/banners?placement=hero|promo`, `POST|PUT|DELETE /api/banners/:id` (admin) · `GET /api/config` (currency, shipping rules).

### Cart & wishlist (logged-in users; guests keep them in the browser and they merge on login)
`GET /api/cart` · `POST /api/cart/items { productId, size, color | variantId, quantity }` · `PATCH /api/cart/items/:itemId { quantity }` ·
`DELETE /api/cart/items/:itemId` · `DELETE /api/cart` · `POST /api/cart/merge { items }` ·
`GET /api/wishlist` · `POST|DELETE /api/wishlist/:productId` · `POST /api/wishlist/merge { productIds }` · `GET /api/users/me/recently-viewed`

### Checkout & orders
| Method | Path | Access |
| --- | --- | --- |
| POST | `/api/orders/quote` | public — price preview `{ items, couponCode?, email? }` |
| POST | `/api/coupons/validate` | public — `{ code, items, email? }` |
| POST | `/api/orders` | guests and customers — `{ items, customer { name, email, phone }, shippingAddress, billingAddress?, paymentMethod: cod|bank_transfer, couponCode?, notes? }` |
| GET | `/api/orders/my` | user |
| GET | `/api/orders/:id` | owner or admin (id or order number) |
| GET | `/api/orders/track?orderNumber=&email=` | public (guest tracking) |
| PATCH | `/api/orders/:id/cancel` | owner, while pending/confirmed |
| GET | `/api/orders?status=&search=&page=` | admin |
| PATCH | `/api/orders/:id/status` | admin — `{ orderStatus?, paymentStatus?, note? }` |

Prices, discounts and shipping are always recalculated on the server; prices sent by the browser are ignored.
Order statuses: `pending → confirmed → processing → shipped → delivered`, or `cancelled`.

**Inventory:** stock is deducted atomically per variant when the order is placed (so two shoppers can never buy the last item),
and returned to stock when an order is cancelled (by the customer or an admin). Coupon usage is released on cancellation too.

### Coupons (admin)
`GET|POST /api/coupons`, `PUT|DELETE /api/coupons/:id`, `GET /api/coupons/public` (active codes for the storefront).
Fields: `code, type (percentage|fixed), value, minimumAmount, maxDiscount, expiryDate, active, usageLimit, firstOrderOnly`.

### Admin
`GET /api/admin/dashboard?range=day|week|month|year` (totals, revenue, pending orders, low stock, recent orders, top products) ·
`GET /api/admin/sales?range=` (daily revenue/orders) · `GET /api/admin/customers` · `PATCH /api/admin/customers/:id { role?, active? }` ·
`GET /api/admin/messages`, `PATCH /api/admin/messages/:id` (contact form inbox)

### Contact & newsletter
`POST /api/contact { name, email, phone?, subject?, message }` · `POST /api/newsletter { email }`

## Security

* Passwords hashed with bcrypt (cost 12); JWTs signed with `JWT_SECRET`; logout and password change revoke old tokens.
* Role-based access (`customer`, `admin`) on every write route; admins cannot demote or disable themselves.
* Request validation with zod; MongoDB operator keys stripped from input; search input is regex-escaped.
* Helmet security headers, CORS allow-list, JSON body limit, rate limits on login/register and checkout.
* Uploads: type, extension, size and content checks; images re-encoded; generated file names; no path traversal.
* Server errors are logged; users only see safe messages.

## Sample data

`npm run seed` creates: an admin and a sample customer (from the `SEED_*` variables), 6 categories with images,
18 products (shirts, linen shirts, polos, tees, shorts, trousers) with 4 generated images each, sizes, colours,
per-variant stock (some low), sale and featured products, 4 coupons (`CSTYLE10`, `SUMMER20`, `NEWUSER`, expired `FLASH15`),
3 banners, and 3 sample orders plus a review for the sample customer.
