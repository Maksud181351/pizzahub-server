# PizzaHub (Server)

REST API for **PizzaHub**, a pizza ordering & delivery platform. Handles menu items, orders, admin moderation, Stripe subscriptions and JWT-verified, role-based access.

- **Live API:** `<ADD LIVE API URL>`
- **Client repo:** `<ADD CLIENT REPO URL>` | **Server repo:** `<ADD SERVER REPO URL>`

## Tech stack (npm packages)
`express`, `mongodb`, `jose` (JWT/JWKS verification), `stripe`, `cors`, `helmet`, `dotenv`.

## Installation & run locally
```bash
git clone <server repo> && cd pizzahub-server
npm install
cp .env.example .env     # fill in the values
npm run dev              # http://localhost:5000
```
Stripe webhooks locally:
```bash
stripe listen --forward-to localhost:5000/api/stripe/webhook   # copy the whsec_... value into STRIPE_WEBHOOK_SECRET
```
Test card: `4242 4242 4242 4242`.

## Environment variables
`PORT`, `MONGODB_URI`, `MONGODB_DB`, `CLIENT_URL` (comma-separated allowed origins), `BETTER_AUTH_URL` (Next.js app URL, used to fetch the JWKS and validate issuer/audience), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PREMIUM_PRICE_USD`.
Never commit `.env`.

## Auth & security model
```
Request ─▶ verifyJWT ─▶ requireRole(...) ─▶ handler (ownership check + validation)
```
- `verifyJWT`: reads `Bearer` token, verifies it against Better Auth's JWKS (signature, expiry, issuer, audience), loads the user from MongoDB. **401** on missing/invalid/expired token or unknown user, **403** for blocked users.
- `requireRole("vendor" | "customer" | "admin")`: **403** if the DB role doesn't match. The client can never choose its role or user id.
- Ownership is verified in every update/delete (vendor items, customer cancel, vendor order decisions). State changes are atomic (`updateOne` filtered by owner + `status: "pending"`), so an order can only be decided once.
- Admin has **no write route** for transactions.

## API overview
| Method & path | Access |
|---|---|
| `GET /api/menu` (search, category, location, minPrice, maxPrice, sort, page, limit) | public (approved items, non-blocked vendors) |
| `GET /api/menu/featured`, `/api/menu/meta`, `/api/menu/:id` | public |
| `POST /api/orders`, `GET /api/orders/mine`, `GET /api/orders/stats`, `PATCH /api/orders/:id/cancel` | customer |
| `GET /api/orders/:id` | customer/vendor of the order, admin |
| `GET /api/vendor/stats`, `/menu`, `/menu/:id`, `POST /menu`, `PUT /menu/:id`, `PATCH /menu/:id/availability`, `DELETE /menu/:id` | vendor |
| `GET /api/vendor/orders`, `PATCH /api/vendor/orders/:id/status` | vendor |
| `POST /api/payments/checkout-session`, `GET /session/:id`, `GET /subscription`, `POST /cancel` | vendor |
| `POST /api/stripe/webhook` | Stripe (signature verified) |
| `GET /api/admin/stats`, `/users`, `/users/:id`, `PATCH /users/:id/block`, `/menu`, `PATCH /menu/:id/status`, `DELETE /menu/:id`, `/transactions` | admin |
| `GET /api/users/me`, `POST /api/users/me/onboard` | any signed-in user |

## Business rules implemented
- Free plan: max 3 **active** items (pending + approved); Premium unlimited. Enforced on create, resume and re-submit.
- New items are `pending`. Only `approved` items from non-blocked vendors are public. Editing an item re-submits it for review.
- Orders: customers only, not for own items, only approved items, no duplicate active order for the same item + date, only pending orders can be cancelled/accepted/rejected.
- When Premium ends the 3 oldest active items stay live, the rest are paused (`inactiveBy: "plan"`).

## Stripe flow (Premium is webhook-only)
1. Vendor clicks **Upgrade**, `POST /api/payments/checkout-session` creates a Checkout Session (vendor id comes from the JWT only).
2. Stripe redirects to `/payment/success?session_id=...`. That page **does not activate anything**: it polls `GET /api/payments/session/:id`, which reports what the webhook has recorded.
3. `POST /api/stripe/webhook` (raw body, signature verified) handles:
   `checkout.session.completed` (create transaction + activate Premium), `invoice.paid` (renewals), `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted` (downgrade).
   Transactions are upserted by session/invoice id, so retries are idempotent.

Configure the production endpoint `https://<api>/api/stripe/webhook` with those five events.

## Challenge notes
- **Advanced search & sorting:** see `src/routes/menu.js` (`$lookup` vendor, multi-term `$and` of `$or` regex matches, `$facet` for pagination, sort by `price`).
- **JWT verification middleware:** `src/middleware/auth.js` (flow above).

## Suggested commit plan (12+ meaningful commits)
1. Initialise Express app with CORS, helmet and error handling
2. Add MongoDB connection and shared utilities
3. Add JWT verification middleware (Better Auth JWKS)
4. Add role-based middleware
5. Add public menu routes with search, filters and sorting
6. Add vendor menu CRUD with free-plan limit
7. Add customer order creation with validation and duplicate protection
8. Add order cancel and vendor accept/reject with atomic updates
9. Add admin user management and block/unblock
10. Add admin menu moderation and transactions (read-only)
11. Add Stripe checkout session endpoint
12. Add verified Stripe webhook and subscription lifecycle
13. Add dashboard stats endpoints
14. Write README

## Deploying
Works on Vercel (`vercel.json` included) or any Node host (Render, Railway). Set all env vars, make `CLIENT_URL` the exact production client origin, and use the production webhook secret.
