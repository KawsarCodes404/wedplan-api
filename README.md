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
