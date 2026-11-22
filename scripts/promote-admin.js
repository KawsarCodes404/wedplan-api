import 'dotenv/config';
import { MongoClient } from 'mongodb';

const email = process.argv[2]?.trim().toLowerCase();
const uri = process.env.MONGODB_URI;

if (!email) {
  throw new Error('Usage: npm run admin:promote -- admin@example.com');
}
if (!uri) {
  throw new Error('Set MONGODB_URI in the server environment first.');
}

const client = new MongoClient(uri);

try {
  await client.connect();
  const result = await client
    .db(process.env.DB_NAME || 'wed-plan')
    .collection('user')
    .updateOne(
      { email },
      { $set: { role: 'admin', updatedAt: new Date() } }
    );

  if (!result.matchedCount) {
    throw new Error(`No account was found for ${email}. Create it first.`);
  }

  console.log(`Promoted ${email} to admin.`);
} finally {
  await client.close();
}
