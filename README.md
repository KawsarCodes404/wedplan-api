# WedPlan API

The backend API for **WedPlan**, a wedding-services marketplace that connects couples with verified vendors. It supports service discovery, bookings, vendor dashboards, subscriptions, and administration.

## Features

- Public service and category endpoints with keyword, category, location, and price or newest sorting.
- Customer booking creation and booking history.
- Vendor service management, booking responses, overview data, and subscription status.
- Admin endpoints for users, services, transactions, and marketplace overview.
- Better Auth JWT verification, role checks, blocked-account checks, and resource ownership checks for protected routes.
- Stripe Checkout subscriptions. A verified Stripe webhook activates or updates Premium; the success page alone does not grant access.
- ImgBB image uploads through the API, keeping the API key on the server.
- MongoDB indexes for common marketplace queries.

## Technology Stack

- Node.js and Express 5
- MongoDB
- Better Auth JWT and JWKS verification
- Stripe Checkout and webhooks
- ImgBB image hosting
- Vercel deployment

## Live Websites

| App | Live URL |
| --- | --- |
| Client website | [wedplan-marketplace.vercel.app](https://wedplan-marketplace.vercel.app) |
| Server project on Vercel | [wedplan-api](https://vercel.com/ridwanul-hoque-kawsar/wedplan-api) |

## Repositories

- **Client repository:** [wedplan-marketplace](https://github.com/KawsarCodes404/wedplan-marketplace)
- **Server repository:** [wedplan-api](https://github.com/KawsarCodes404/wedplan-api)

## Installation

1. Install Node.js (LTS) and MongoDB access for the project database.
2. Clone this repository and install its packages:

   ```bash
   git clone https://github.com/KawsarCodes404/wedplan-api.git
   cd wedplan-api
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in the required values. Keep real credentials in `.env`; never commit them.

   Main settings include `PORT`, `MONGODB_URI`, `DB_NAME`, `CLIENT_URL`, `BETTER_AUTH_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `IMGBB_API_KEY`. See `.env.example` for the complete list.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | Private MongoDB connection string. Alternatively, configure `DB_USER` and `DB_PASSWORD`. |
| `DB_USER`, `DB_PASSWORD` | Optional private MongoDB credentials when `MONGODB_URI` is not set. |
| `MONGODB_HOST` | Optional Atlas host list when using `DB_USER` and `DB_PASSWORD`. |
| `DB_NAME` | MongoDB database shared with the client Better Auth instance. |
| `BETTER_AUTH_URL` | Canonical client origin used for JWT issuer, audience, and JWKS verification. |
| `CLIENT_URL` | Optional client origin allowed by CORS and used for Stripe redirects. Defaults to `BETTER_AUTH_URL`. |
| `PORT` | Local API port; defaults to `5000`. |
| `STRIPE_SECRET_KEY` | Private Stripe test-mode secret key. |
| `STRIPE_WEBHOOK_SECRET` | Secret used to verify Stripe webhook signatures. |
| `STRIPE_PREMIUM_PRICE_ID` | Optional Stripe recurring price. If omitted, the configured amount and currency are used. |
| `STRIPE_PREMIUM_AMOUNT`, `STRIPE_PREMIUM_CURRENCY` | Premium plan price when no Stripe price ID is configured. |
| `IMGBB_API_KEY` | Private ImgBB upload key. |

Never expose server keys with a `NEXT_PUBLIC_` prefix or commit `.env` files.

## Deployment

1. Deploy the API with its MongoDB, Better Auth, client URL, Stripe, and ImgBB environment variables.
2. Set `BETTER_AUTH_URL` to the deployed client origin on the API. Stripe redirects use `CLIENT_URL` when set, otherwise they use `BETTER_AUTH_URL`. CORS allows those configured origins and localhost during development.
3. Deploy the client with the matching MongoDB database and Better Auth settings, Google OAuth credentials, and `NEXT_PUBLIC_API_BASE_URL` pointing to this API.
4. Add the API's `/payments/webhook` URL in Stripe and enable `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted` events.
5. Redeploy the API and client after changing environment variables.

Public registration cannot create admin accounts. Create the account normally, then promote it from a trusted environment with `npm run admin:promote -- admin@example.com`. Keep admin credentials out of GitHub.

## Run Locally

Start the development server:

```bash
npm run dev
```

The API listens on port `5000` by default. Use `npm start` to run it without the development watcher. Run the frontend separately and set its API base URL to `http://localhost:5000`.

## Main API Routes

| Area | Routes |
| --- | --- |
| Discovery | `GET /categories`, `GET /services`, `GET /services/:id` |
| Profile | `GET /auth/session`, `PATCH /users/me` |
| Customer | `POST /bookings`, `GET /customer/bookings`, `GET /customer/overview` |
| Vendor | `/vendor/services`, `/vendor/bookings`, `/vendor/overview`, `/vendor/transactions` |
| Admin | `/admin/overview`, `/admin/users`, `/admin/services`, `/admin/transactions` |
| Payments and images | `POST /payments/checkout-session`, `POST /payments/webhook`, `POST /images/upload` |

Protected routes require a Better Auth JWT in the `Authorization: Bearer <token>` header. The API checks the signed token and current account role/status before applying role and ownership rules.

## Premium Subscription Notes

Free vendors can have up to three active services. Premium vendors can publish unlimited active services and receive a Premium badge. Configure Stripe price and webhook values in the backend environment. For local webhook testing, forward Stripe events to `http://localhost:5000/payments/webhook` with the Stripe CLI. Never expose Stripe secrets in the frontend.
