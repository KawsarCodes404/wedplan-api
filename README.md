# WedPlan API

Express and MongoDB API for the WedPlan marketplace. It uses the same `wed-plan` database as Better Auth, reading its `user` and `session` collections and storing marketplace data in `services`, `bookings`, and `transactions`.

## Run locally

1. Copy `.env.example` to `.env` and set the MongoDB connection string, frontend origin, and Stripe values.
2. Install dependencies with `npm install`.
3. Start the API with `npm run dev` (or `npm start`). It listens on port 5000 by default.

## API areas

- Public discovery: `GET /categories`, `GET /services`, `GET /services/:id`. Search supports `search`, `category`, `location`, and `sort=newest|priceAsc|priceDesc`.
- Profile: `GET /auth/session`, `PATCH /users/me`.
- Vendor: `/vendor/services`, `/vendor/bookings`, `/vendor/overview`, `/vendor/transactions`, `/payments/checkout-session`.
- Customer: `/bookings`, `/customer/bookings`, `/customer/overview`.
- Admin: `/admin/overview`, `/admin/users`, `/admin/services`, `/admin/transactions`.
- Stripe webhook: `POST /payments/webhook`.

Protected API requests require `Authorization: Bearer <Better Auth session token>`. Role, ownership, booking transitions, service approval, and subscription activation are checked by the API. Premium access is activated only from a verified Stripe webhook.

The sample environment file contains placeholders only. Keep real credentials in `.env`, which is ignored by Git.
