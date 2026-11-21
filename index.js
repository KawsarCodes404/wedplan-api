import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { MongoClient, ObjectId } from 'mongodb'
import Stripe from 'stripe'

const app = express()
const port = Number(process.env.PORT || 5000)
const databaseName = process.env.DB_NAME || 'wed-plan'
const mongoUri = process.env.MONGODB_URI || buildMongoUriFromLegacyCredentials()
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null

function buildMongoUriFromLegacyCredentials() {
  const { DB_USER, DB_PASSWORD } = process.env
  if (!DB_USER || !DB_PASSWORD) return undefined

  // Keep deployments using the original credential variables working while
  // allowing newer environments to provide a complete MONGODB_URI.
  const host = process.env.MONGODB_HOST ||
    'ac-tfbmyvt-shard-00-00.drmhua0.mongodb.net:27017,ac-tfbmyvt-shard-00-01.drmhua0.mongodb.net:27017,ac-tfbmyvt-shard-00-02.drmhua0.mongodb.net:27017'
  const user = encodeURIComponent(DB_USER)
  const password = encodeURIComponent(DB_PASSWORD)
  return `mongodb://${user}:${password}@${host}/?ssl=true&replicaSet=atlas-ggve46-shard-0&authSource=admin`
}

if (!mongoUri) {
  throw new Error('Set MONGODB_URI or both DB_USER and DB_PASSWORD.')
}

const client = new MongoClient(mongoUri)
await client.connect()

const database = client.db(databaseName)
const users = database.collection('user')
const sessions = database.collection('session')
const services = database.collection('services')
const bookings = database.collection('bookings')
const transactions = database.collection('transactions')

const categories = [
  'Photography & Videography',
  'Wedding Venues',
  'Decoration & Florist',
  'Catering Services',
  'Makeup & Styling',
  'Wedding Fashion',
]

const validRoles = ['admin', 'vendor', 'customer']
const validServiceStatuses = ['Pending', 'Approved', 'Rejected']
const validBookingStatuses = ['Pending', 'Accepted', 'Rejected', 'Cancelled']

app.use(cors())

// Stripe requires the unparsed request body to verify webhook signatures.
app.post('/payments/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook)
app.use(express.json({ limit: '1mb' }))

app.get('/', (_request, response) => {
  response.json({ name: 'WedPlan API', status: 'ok' })
})

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

// Public discovery only returns approved, available services from active vendors.
app.get('/services', async (request, response) => {
  const { search = '', category = '', location = '', sort = 'newest', featured } = request.query
  const filter = { status: 'Approved', isActive: { $ne: false } }

  if (category && categories.includes(String(category))) filter.category = String(category)
  if (featured === 'true') filter.featured = true
  if (search) {
    const expression = escapeRegex(String(search).trim().slice(0, 80))
    filter.$or = [
      { serviceName: { $regex: expression, $options: 'i' } },
      { description: { $regex: expression, $options: 'i' } },
      { category: { $regex: expression, $options: 'i' } },
    ]
  }
  if (location) {
    filter.location = { $regex: escapeRegex(String(location).trim().slice(0, 80)), $options: 'i' }
  }

  const sortOptions = {
    newest: { createdAt: -1 },
    priceAsc: { price: 1, createdAt: -1 },
    priceDesc: { price: -1, createdAt: -1 },
  }
  const sortBy = sortOptions[String(sort)] || sortOptions.newest
  const page = Math.max(1, Number.parseInt(String(request.query.page || '1'), 10) || 1)
  const limit = Math.min(24, Math.max(1, Number.parseInt(String(request.query.limit || '12'), 10) || 12))
  const total = await services.countDocuments(filter)
  const rows = await services.find(filter).sort(sortBy).skip((page - 1) * limit).limit(limit).toArray()
  const enriched = await addVendorDetails(rows)

  response.json({ services: enriched, total, page, limit, pages: Math.ceil(total / limit) })
})

app.get('/services/:id', async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service || service.status !== 'Approved' || service.isActive === false) {
    return response.status(404).json({ message: 'Wedding service not found.' })
  }

  const [enriched] = await addVendorDetails([service])
  return response.json(enriched)
})

app.get('/categories', (_request, response) => response.json(categories))

app.get('/auth/session', verifyToken, (request, response) => {
  response.json({ user: publicUser(request.user) })
})

// Profile updates accept editable fields only. Role and subscription fields
// are deliberately not read from the request body.
app.patch('/users/me', verifyToken, async (request, response) => {
  const name = cleanText(request.body.name, 80)
  const image = cleanImageUrl(request.body.image)
  const businessName = cleanText(request.body.businessName, 100)
  const location = cleanText(request.body.location, 120)
  const bio = cleanText(request.body.bio, 500)
  const update = { updatedAt: new Date() }

  if (name) update.name = name
  if (request.body.image !== undefined) update.image = image
  if (request.user.role === 'vendor' && request.body.businessName !== undefined) {
    update.businessName = businessName
  }
  if (request.body.location !== undefined) update.location = location
  if (request.body.bio !== undefined) update.bio = bio

  await users.updateOne({ _id: request.user._id }, { $set: update })
  const saved = await users.findOne({ _id: request.user._id })
  response.json({ user: publicUser(saved), message: 'Profile updated.' })
})

// Vendor service management
app.get('/vendor/services', verifyToken, requireRole('vendor'), async (request, response) => {
  const rows = await services.find({ vendorId: userId(request.user) }).sort({ createdAt: -1 }).toArray()
  response.json(rows)
})

app.post('/vendor/services', verifyToken, requireRole('vendor'), async (request, response) => {
  const service = parseService(request.body)
  if (!service) return response.status(400).json({ message: 'Complete all required service fields.' })

  if (!isPremium(request.user)) {
    const activeCount = await services.countDocuments({
      vendorId: userId(request.user),
      status: 'Approved',
      isActive: { $ne: false },
    })
    if (activeCount >= 3) {
      return response.status(403).json({ message: 'The Free plan includes up to 3 active services.' })
    }
  }

  const document = {
    ...service,
    vendorId: userId(request.user),
    status: 'Pending',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const result = await services.insertOne(document)
  response.status(201).json({ service: { ...document, _id: result.insertedId }, message: 'Service submitted for review.' })
})

app.patch('/vendor/services/:id', verifyToken, requireRole('vendor'), async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  if (service.vendorId !== userId(request.user)) return response.status(403).json({ message: 'You cannot edit this service.' })

  const parsed = parseService(request.body)
  if (!parsed) return response.status(400).json({ message: 'Complete all required service fields.' })
  const update = { ...parsed, status: 'Pending', updatedAt: new Date() }
  await services.updateOne({ _id: service._id }, { $set: update })
  response.json({ service: { ...service, ...update }, message: 'Service updated and sent for review.' })
})

app.patch('/vendor/services/:id/availability', verifyToken, requireRole('vendor'), async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  if (service.vendorId !== userId(request.user)) return response.status(403).json({ message: 'You cannot edit this service.' })
  if (typeof request.body.isActive !== 'boolean') return response.status(400).json({ message: 'Availability must be true or false.' })
  if (request.body.isActive && service.status !== 'Approved') {
    return response.status(409).json({ message: 'Only approved services can be made available.' })
  }
  if (request.body.isActive && !isPremium(request.user)) {
    const count = await services.countDocuments({
      vendorId: userId(request.user), status: 'Approved', isActive: { $ne: false },
    })
    if (count >= 3 && !service.isActive) return response.status(403).json({ message: 'The Free plan includes up to 3 active services.' })
  }
  await services.updateOne({ _id: service._id }, { $set: { isActive: request.body.isActive, updatedAt: new Date() } })
  response.json({ message: `Service ${request.body.isActive ? 'activated' : 'paused'}.` })
})

app.delete('/vendor/services/:id', verifyToken, requireRole('vendor'), async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  if (service.vendorId !== userId(request.user)) return response.status(403).json({ message: 'You cannot delete this service.' })
  await services.deleteOne({ _id: service._id })
  response.status(204).end()
})

app.get('/vendor/overview', verifyToken, requireRole('vendor'), async (request, response) => {
  const owner = userId(request.user)
  const [serviceCount, activeServices, pendingBookings, acceptedBookings] = await Promise.all([
    services.countDocuments({ vendorId: owner }),
    services.countDocuments({ vendorId: owner, status: 'Approved', isActive: { $ne: false } }),
    bookings.countDocuments({ vendorId: owner, status: 'Pending' }),
    bookings.countDocuments({ vendorId: owner, status: 'Accepted' }),
  ])
  response.json({ serviceCount, activeServices, pendingBookings, acceptedBookings, subscriptionPlan: isPremium(request.user) ? 'Premium' : 'Free' })
})

// Booking requests
app.post('/bookings', verifyToken, requireRole('customer'), async (request, response) => {
  const service = await findById(services, request.body.serviceId)
  if (!service || service.status !== 'Approved' || service.isActive === false) {
    return response.status(404).json({ message: 'This service is not available for booking.' })
  }

  const customerId = userId(request.user)
  if (service.vendorId === customerId) return response.status(403).json({ message: 'You cannot book your own service.' })
  const eventDate = parseEventDate(request.body.eventDate)
  const eventLocation = cleanText(request.body.eventLocation, 160)
  const message = cleanText(request.body.message, 1000)
  if (!eventDate || !eventLocation) return response.status(400).json({ message: 'Choose an event date and enter its location.' })

  const duplicate = await bookings.findOne({
    serviceId: service._id.toString(), customerId, eventDate,
    status: { $in: ['Pending', 'Accepted'] },
  })
  if (duplicate) return response.status(409).json({ message: 'You already have an active request for this service and date.' })

  const booking = {
    serviceId: service._id.toString(),
    vendorId: service.vendorId,
    customerId,
    eventDate,
    eventLocation,
    message,
    status: 'Pending',
    createdAt: new Date(),
  }
  const result = await bookings.insertOne(booking)
  response.status(201).json({ booking: { ...booking, _id: result.insertedId }, message: 'Booking request sent to the vendor.' })
})

app.get('/customer/bookings', verifyToken, requireRole('customer'), async (request, response) => {
  const rows = await bookings.find({ customerId: userId(request.user) }).sort({ createdAt: -1 }).toArray()
  response.json(await addBookingDetails(rows))
})

app.get('/customer/overview', verifyToken, requireRole('customer'), async (request, response) => {
  const owner = userId(request.user)
  const [total, pending, accepted, rejected, recent] = await Promise.all([
    bookings.countDocuments({ customerId: owner }),
    bookings.countDocuments({ customerId: owner, status: 'Pending' }),
    bookings.countDocuments({ customerId: owner, status: 'Accepted' }),
    bookings.countDocuments({ customerId: owner, status: 'Rejected' }),
    bookings.find({ customerId: owner }).sort({ createdAt: -1 }).limit(4).toArray(),
  ])
  response.json({ total, pending, accepted, rejected, recent: await addBookingDetails(recent) })
})

app.patch('/customer/bookings/:id/cancel', verifyToken, requireRole('customer'), async (request, response) => {
  const booking = await findById(bookings, request.params.id)
  if (!booking) return response.status(404).json({ message: 'Booking request not found.' })
  if (booking.customerId !== userId(request.user)) return response.status(403).json({ message: 'You cannot change this booking.' })
  const result = await bookings.updateOne(
    { _id: booking._id, customerId: userId(request.user), status: 'Pending' },
    { $set: { status: 'Cancelled', updatedAt: new Date() } },
  )
  if (!result.modifiedCount) return response.status(409).json({ message: 'Only pending booking requests can be cancelled.' })
  response.json({ message: 'Booking request cancelled.' })
})

app.get('/vendor/bookings', verifyToken, requireRole('vendor'), async (request, response) => {
  const rows = await bookings.find({ vendorId: userId(request.user) }).sort({ createdAt: -1 }).toArray()
  response.json(await addBookingDetails(rows))
})

app.patch('/vendor/bookings/:id/status', verifyToken, requireRole('vendor'), async (request, response) => {
  const nextStatus = request.body.status
  if (!['Accepted', 'Rejected'].includes(nextStatus)) return response.status(400).json({ message: 'Choose Accepted or Rejected.' })
  const booking = await findById(bookings, request.params.id)
  if (!booking) return response.status(404).json({ message: 'Booking request not found.' })
  if (booking.vendorId !== userId(request.user)) return response.status(403).json({ message: 'You cannot change this booking.' })
  const result = await bookings.updateOne(
    { _id: booking._id, vendorId: userId(request.user), status: 'Pending' },
    { $set: { status: nextStatus, updatedAt: new Date() } },
  )
  if (!result.modifiedCount) return response.status(409).json({ message: 'This request has already been processed.' })
  response.json({ message: `Booking request ${nextStatus.toLowerCase()}.` })
})

// Admin APIs
app.get('/admin/overview', verifyToken, requireRole('admin'), async (_request, response) => {
  const [totalUsers, vendors, customers, serviceCount, pendingServices, transactionCount, revenue] = await Promise.all([
    users.countDocuments({}),
    users.countDocuments({ role: 'vendor' }),
    users.countDocuments({ role: 'customer' }),
    services.countDocuments({}),
    services.countDocuments({ status: 'Pending' }),
    transactions.countDocuments({}),
    transactions.aggregate([
      { $match: { status: 'Completed' } },
      { $group: { _id: null, amount: { $sum: '$amount' } } },
    ]).toArray(),
  ])
  response.json({ totalUsers, vendors, customers, serviceCount, pendingServices, transactionCount, revenue: revenue[0]?.amount || 0 })
})

app.get('/admin/users', verifyToken, requireRole('admin'), async (request, response) => {
  const filter = {}
  const role = String(request.query.role || '')
  if (validRoles.includes(role)) filter.role = role
  if (request.query.search) {
    const expression = escapeRegex(String(request.query.search).slice(0, 80))
    filter.$or = [
      { name: { $regex: expression, $options: 'i' } },
      { email: { $regex: expression, $options: 'i' } },
      { businessName: { $regex: expression, $options: 'i' } },
    ]
  }
  const rows = await users.find(filter, { projection: { name: 1, email: 1, image: 1, role: 1, isBlocked: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1 } }).sort({ name: 1 }).limit(200).toArray()
  response.json(rows)
})

app.patch('/admin/users/:id/block', verifyToken, requireRole('admin'), async (request, response) => {
  if (typeof request.body.isBlocked !== 'boolean') return response.status(400).json({ message: 'isBlocked must be true or false.' })
  const target = await findById(users, request.params.id)
  if (!target) return response.status(404).json({ message: 'User not found.' })
  if (target._id.equals?.(request.user._id) || userId(target) === userId(request.user)) {
    return response.status(400).json({ message: 'You cannot block your own admin account.' })
  }
  await users.updateOne({ _id: target._id }, { $set: { isBlocked: request.body.isBlocked } })
  response.json({ message: `User ${request.body.isBlocked ? 'blocked' : 'unblocked'}.` })
})

app.get('/admin/services', verifyToken, requireRole('admin'), async (request, response) => {
  const filter = {}
  if (validServiceStatuses.includes(String(request.query.status))) filter.status = String(request.query.status)
  if (categories.includes(String(request.query.category))) filter.category = String(request.query.category)
  if (request.query.search) {
    const expression = escapeRegex(String(request.query.search).slice(0, 80))
    filter.$or = [
      { serviceName: { $regex: expression, $options: 'i' } },
      { location: { $regex: expression, $options: 'i' } },
    ]
  }
  const rows = await services.find(filter).sort({ createdAt: -1 }).limit(200).toArray()
  response.json(await addVendorDetails(rows))
})

app.patch('/admin/services/:id/review', verifyToken, requireRole('admin'), async (request, response) => {
  const status = request.body.status
  if (!['Approved', 'Rejected'].includes(status)) return response.status(400).json({ message: 'Choose Approved or Rejected.' })
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  await services.updateOne({ _id: service._id }, { $set: { status, updatedAt: new Date() } })
  response.json({ message: `Service ${status.toLowerCase()}.` })
})

app.patch('/admin/services/:id/availability', verifyToken, requireRole('admin'), async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  if (typeof request.body.isActive !== 'boolean') return response.status(400).json({ message: 'Availability must be true or false.' })
  if (request.body.isActive && service.status !== 'Approved') return response.status(409).json({ message: 'Only approved services can be activated.' })
  await services.updateOne({ _id: service._id }, { $set: { isActive: request.body.isActive, updatedAt: new Date() } })
  response.json({ message: `Service ${request.body.isActive ? 'activated' : 'paused'}.` })
})

app.delete('/admin/services/:id', verifyToken, requireRole('admin'), async (request, response) => {
  const service = await findById(services, request.params.id)
  if (!service) return response.status(404).json({ message: 'Service not found.' })
  await services.deleteOne({ _id: service._id })
  response.status(204).end()
})

app.get('/admin/transactions', verifyToken, requireRole('admin'), async (_request, response) => {
  const rows = await transactions.find({}).sort({ createdAt: -1 }).limit(200).toArray()
  response.json(await addTransactionVendorDetails(rows))
})

// Vendors can inspect only their own subscription payment history.
app.get('/vendor/transactions', verifyToken, requireRole('vendor'), async (request, response) => {
  const rows = await transactions.find({ vendorId: userId(request.user) }).sort({ createdAt: -1 }).toArray()
  response.json(rows)
})

app.get('/payments/checkout-session/:sessionId', verifyToken, requireRole('vendor'), async (request, response) => {
  const transaction = await transactions.findOne({
    stripeSessionId: request.params.sessionId,
    vendorId: userId(request.user),
  })
  if (!transaction) return response.status(404).json({ message: 'Checkout session not found.' })
  response.json({ status: transaction.status, plan: transaction.plan })
})

app.post('/payments/checkout-session', verifyToken, requireRole('vendor'), async (request, response) => {
  if (!stripe) return response.status(503).json({ message: 'Payments are not configured.' })
  if (isPremium(request.user)) return response.status(409).json({ message: 'Your Premium plan is already active.' })
  const origin = (process.env.CLIENT_URL || 'http://localhost:3000').replace(/\/$/, '')
  if (!origin) return response.status(503).json({ message: 'Application URL is not configured.' })

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: request.user.email,
    line_items: [premiumLineItem()],
    metadata: { vendorId: userId(request.user), plan: 'Premium' },
    subscription_data: { metadata: { vendorId: userId(request.user), plan: 'Premium' } },
    success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/checkout/cancel`,
  })
  await transactions.updateOne(
    { stripeSessionId: session.id },
    { $setOnInsert: {
      vendorId: userId(request.user), plan: 'Premium', amount: premiumAmount(), currency: premiumCurrency(),
      stripeSessionId: session.id, stripeSubscriptionId: null, status: 'Pending', createdAt: new Date(),
    } },
    { upsert: true },
  )
  response.json({ url: session.url })
})

app.use((_request, response) => response.status(404).json({ message: 'Route not found.' }))

app.use((error, _request, response, _next) => {
  console.error('API error:', error?.message || error)
  if (response.headersSent) return
  response.status(error.status || 500).json({ message: error.status ? error.message : 'Something went wrong. Please try again.' })
})

app.listen(port, () => console.log(`WedPlan API listening on port ${port}`))

async function verifyToken(request, response, next) {
  try {
    const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return response.status(401).json({ message: 'Sign in to continue.' })

    const session = await sessions.findOne({ token, expiresAt: { $gt: new Date() } })
    if (!session) return response.status(401).json({ message: 'Your session is invalid or expired.' })

    const user = await findById(users, String(session.userId))
    if (!user) return response.status(401).json({ message: 'Account not found.' })
    if (user.isBlocked) return response.status(403).json({ message: 'This account is blocked.' })
    request.user = user
    return next()
  } catch (error) {
    return next(error)
  }
}

function requireRole(role) {
  return (request, response, next) => {
    if (request.user?.role !== role) return response.status(403).json({ message: 'You do not have permission to access this resource.' })
    return next()
  }
}

async function handleStripeWebhook(request, response) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return response.status(503).json({ message: 'Stripe webhook is not configured.' })
  }
  let event
  try {
    event = stripe.webhooks.constructEvent(request.body, request.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)
  } catch (error) {
    return response.status(400).send(`Webhook signature verification failed: ${error.message}`)
  }

  if (event.type === 'checkout.session.completed') {
    const checkout = event.data.object
    if (checkout.mode === 'subscription' && checkout.payment_status === 'paid') {
      const vendorId = checkout.metadata?.vendorId
      const vendor = vendorId ? await findById(users, vendorId) : null
      if (vendor?.role === 'vendor') {
        const subscriptionId = typeof checkout.subscription === 'string' ? checkout.subscription : checkout.subscription?.id
        const subscription = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null
        const expiresAt = subscription?.current_period_end ? new Date(subscription.current_period_end * 1000) : null

        await users.updateOne({ _id: vendor._id }, { $set: {
          subscriptionPlan: 'Premium', subscriptionExpiresAt: expiresAt,
        } })
        await transactions.updateOne(
          { stripeSessionId: checkout.id },
          { $set: {
            vendorId, plan: 'Premium', amount: checkout.amount_total || premiumAmount(),
            currency: (checkout.currency || premiumCurrency()).toUpperCase(), stripeSubscriptionId: subscriptionId || null,
            status: 'Completed', completedAt: new Date(),
          }, $setOnInsert: { stripeSessionId: checkout.id, createdAt: new Date() } },
          { upsert: true },
        )
      }
    }
  }

  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
    const checkout = event.data.object
    await transactions.updateOne(
      { stripeSessionId: checkout.id, status: 'Pending' },
      { $set: {
        status: event.type === 'checkout.session.expired' ? 'Cancelled' : 'Failed',
        updatedAt: new Date(),
      } },
    )
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object
    const vendorId = subscription.metadata?.vendorId
    const vendor = vendorId ? await findById(users, vendorId) : null
    if (vendor?.role === 'vendor') {
      const isActive = ['active', 'trialing'].includes(subscription.status)
      await users.updateOne({ _id: vendor._id }, { $set: {
        subscriptionPlan: isActive ? 'Premium' : 'Free',
        subscriptionExpiresAt: isActive && subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null,
      } })
      if (event.type === 'customer.subscription.deleted') {
        await transactions.updateMany(
          { stripeSubscriptionId: subscription.id, status: 'Completed' },
          { $set: { status: 'Cancelled', cancelledAt: new Date() } },
        )
      }
    }
  }

  response.json({ received: true })
}

function premiumLineItem() {
  if (process.env.STRIPE_PREMIUM_PRICE_ID) return { price: process.env.STRIPE_PREMIUM_PRICE_ID, quantity: 1 }
  return {
    quantity: 1,
    price_data: {
      currency: premiumCurrency(),
      unit_amount: premiumAmount(),
      recurring: { interval: 'month' },
      product_data: { name: 'WedPlan Premium Plan', description: 'Unlimited active wedding service listings.' },
    },
  }
}

function premiumAmount() {
  return Number.parseInt(process.env.STRIPE_PREMIUM_AMOUNT || '2900', 10)
}

function premiumCurrency() {
  return (process.env.STRIPE_PREMIUM_CURRENCY || 'usd').toLowerCase()
}

function parseService(body = {}) {
  const serviceName = cleanText(body.serviceName, 120)
  const category = categories.includes(body.category) ? body.category : ''
  const description = cleanText(body.description, 2000)
  const location = cleanText(body.location, 160)
  const price = Number(body.price)
  if (Array.isArray(body.images) && body.images.length > 6) return null
  const images = Array.isArray(body.images) ? body.images.map(cleanImageUrl).filter(Boolean) : []
  if (!serviceName || !category || !description || !location || !Number.isFinite(price) || price < 0 || images.length === 0) return null
  return { serviceName, category, description, location, price, images }
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function cleanImageUrl(value) {
  if (typeof value !== 'string') return ''
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

function parseEventDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null
  const today = new Date().toISOString().slice(0, 10)
  return value < today ? null : value
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function userId(user) {
  return user?._id?.toString?.() || String(user?._id || '')
}

function isPremium(user) {
  if (user?.subscriptionPlan !== 'Premium') return false
  return !user.subscriptionExpiresAt || new Date(user.subscriptionExpiresAt) > new Date()
}

function publicUser(user) {
  if (!user) return null
  return {
    id: userId(user), name: user.name, email: user.email, image: user.image || null,
    role: user.role, businessName: user.businessName || null, location: user.location || null,
    bio: user.bio || null, isBlocked: Boolean(user.isBlocked),
    subscriptionPlan: isPremium(user) ? 'Premium' : 'Free',
    subscriptionExpiresAt: user.subscriptionExpiresAt || null,
  }
}

async function findById(collection, id) {
  if (typeof id !== 'string' || !id) return null
  if (ObjectId.isValid(id)) {
    const byObjectId = await collection.findOne({ _id: new ObjectId(id) })
    if (byObjectId) return byObjectId
  }
  return collection.findOne({ _id: id })
}

async function addVendorDetails(rows) {
  const ids = [...new Set(rows.map((row) => row.vendorId).filter(Boolean))]
  const objectIds = ids.filter(ObjectId.isValid).map((id) => new ObjectId(id))
  const usersById = new Map()
  if (objectIds.length) {
    const found = await users.find({ _id: { $in: objectIds } }, {
      projection: { name: 1, image: 1, role: 1, businessName: 1, location: 1, bio: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, isBlocked: 1 },
    }).toArray()
    for (const user of found) usersById.set(userId(user), user)
  }
  const stringIds = ids.filter((id) => !ObjectId.isValid(id))
  if (stringIds.length) {
    const found = await users.find({ _id: { $in: stringIds } }, {
      projection: { name: 1, image: 1, role: 1, businessName: 1, location: 1, bio: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, isBlocked: 1 },
    }).toArray()
    for (const user of found) usersById.set(userId(user), user)
  }
  return rows.map((row) => {
    const vendor = usersById.get(String(row.vendorId))
    return { ...row, vendor: vendor && !vendor.isBlocked ? {
      name: vendor.businessName || vendor.name,
      image: vendor.image || null,
      location: vendor.location || null,
      bio: vendor.bio || null,
      isPremium: isPremium(vendor),
    } : null }
  })
}

async function addBookingDetails(rows) {
  const serviceIds = rows.map((row) => row.serviceId).filter(ObjectId.isValid).map((id) => new ObjectId(id))
  const customerIds = rows.map((row) => row.customerId).filter(ObjectId.isValid).map((id) => new ObjectId(id))
  const serviceRows = serviceIds.length ? await services.find({ _id: { $in: serviceIds } }).toArray() : []
  const customerRows = customerIds.length ? await users.find({ _id: { $in: customerIds } }, { projection: { name: 1, email: 1, image: 1 } }).toArray() : []
  const serviceMap = new Map(serviceRows.map((service) => [userId({ _id: service._id }), service]))
  const customerMap = new Map(customerRows.map((user) => [userId(user), user]))
  const vendorRows = await addVendorDetails(serviceRows)
  const vendorMap = new Map(vendorRows.map((service) => [userId({ _id: service._id }), service.vendor]))
  return rows.map((row) => ({
    ...row,
    service: serviceMap.get(String(row.serviceId)) || null,
    customer: customerMap.get(String(row.customerId)) || null,
    vendor: vendorMap.get(String(row.serviceId)) || null,
  }))
}

async function addTransactionVendorDetails(rows) {
  const ids = [...new Set(rows.map((row) => row.vendorId).filter(Boolean))]
  const objectIds = ids.filter(ObjectId.isValid).map((id) => new ObjectId(id))
  const stringIds = ids.filter((id) => !ObjectId.isValid(id))
  const query = []
  if (objectIds.length) query.push({ _id: { $in: objectIds } })
  if (stringIds.length) query.push({ _id: { $in: stringIds } })
  const vendors = query.length ? await users.find({ $or: query }, { projection: { name: 1, email: 1, businessName: 1 } }).toArray() : []
  const vendorMap = new Map(vendors.map((vendor) => [userId(vendor), vendor]))
  return rows.map((row) => ({ ...row, vendor: vendorMap.get(String(row.vendorId)) || null }))
}
