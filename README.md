# WedPlan API

Express and MongoDB API for the WedPlan wedding marketplace. It uses the same `wed-plan` database as Better Auth and stores marketplace data in `services`, `bookings`, and `transactions`.

## Links

- Live site: [https://wedplan.nazmussakib.dev](https://wedplan.nazmussakib.dev)
- Frontend repository: [wed-plan-frontend](https://github.com/KawsarCodes404/wed-plan-frontend)
- Backend repository: [wed-plan-backend](https://github.com/KawsarCodes404/wed-plan-backend)

## Run locally

1. Copy `.env.example` to `.env` and set MongoDB, frontend origin, Better Auth URL, and Stripe values.
2. Install dependencies with `npm install`.
3. Start the API with `npm run dev` (or `npm start`). It listens on port 5000 by default.

## API areas

- Public discovery: `GET /categories`, `GET /services`, `GET /services/:id`. Search supports `search`, `category`, `location`, and `sort=newest|priceAsc|priceDesc`.
- Profile: `GET /auth/session`, `PATCH /users/me`.
- Vendor: `/vendor/services`, `/vendor/bookings`, `/vendor/overview`, `/vendor/transactions`, `/payments/checkout-session`.
- Customer: `/bookings`, `/customer/bookings`, `/customer/overview`.
- Admin: `/admin/overview`, `/admin/users`, `/admin/services`, `/admin/transactions`.
- Stripe webhook: `POST /payments/webhook`.

Protected API requests require `Authorization: Bearer <Better Auth JWT>`. The API verifies the JWT signature with Better Auth’s JWKS endpoint, then checks the user’s current role and blocked status in MongoDB. Resource ownership, booking transitions, and service approval are checked by the API. Premium access is activated only from a verified Stripe webhook.

The API creates indexes for public service searches, vendor and customer dashboards, booking lookups, and Stripe transaction history when it starts.

## Stripe Premium setup

The vendor subscription page already starts a Stripe Checkout subscription. Free vendors can have up to 3 active services; the API blocks additional active listings and shows an upgrade link. Premium vendors get unlimited active services and the Premium badge. Successful payments and cancellations are applied from Stripe webhooks, so the success page alone does not activate a plan.

1. In the Stripe Dashboard, switch to **Test mode** and create a product named **WedPlan Premium** with a recurring **$29 USD monthly** price. The website currently displays this amount. Copy the recurring Price ID (`price_...`).
2. In the backend `.env`, set `STRIPE_SECRET_KEY` to your test secret key (`sk_test_...`) and `STRIPE_PREMIUM_PRICE_ID` to that Price ID. Keep both values on the backend only. If the Price ID is blank, the API creates the same monthly price from `STRIPE_PREMIUM_AMOUNT` (2900 cents) and `STRIPE_PREMIUM_CURRENCY` (`usd`).
3. Set `CLIENT_URL` to your frontend address. For local development, use `http://localhost:3000`.
4. Run Stripe CLI and forward webhooks to the API:

   ```sh
   stripe listen --forward-to localhost:5000/payments/webhook
   ```

   Copy the printed signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET` in the backend `.env`, then restart the API. Keep the CLI running while testing locally.
5. Start both apps, sign in as a vendor, open **Vendor Hub → Subscription**, and click **Upgrade securely with Stripe**. Use a Stripe test card such as `4242 4242 4242 4242`, a future expiry date, and any CVC. After Checkout succeeds, the webhook marks the transaction completed, activates Premium, and the vendor badge appears.

The webhook handles `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_failed`, `customer.subscription.updated`, and `customer.subscription.deleted`. In production, create a webhook endpoint for `https://YOUR_API_HOST/payments/webhook`, select those events, and set the endpoint's signing secret as the production `STRIPE_WEBHOOK_SECRET`. Use live-mode keys and a live-mode Price ID there; test and live Stripe objects are separate. Never commit or paste secret keys into chat or frontend environment variables.

The sample environment file contains placeholders only. Keep real credentials in `.env`, which is ignored by Git.
