import { MongoClient, ObjectId } from "mongodb";
import dns from "node:dns";
if (process.env.NODE_ENV !== "production") dns.setServers(["8.8.8.8", "1.1.1.1"]);

let client;
let dbPromise;

/** Cached connection (works for long running servers and serverless). */
export function getDb() {
  if (!dbPromise) {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
    client = new MongoClient(process.env.MONGODB_URI);
    dbPromise = client.connect().then(() => client.db(process.env.MONGODB_DB || "pizzahub"));
    dbPromise.catch(() => (dbPromise = undefined));
  }
  return dbPromise;
}

export const col = async (name) => (await getDb()).collection(name);

/** Returns an ObjectId or null (never throws) */
export const toObjectId = (value) => {
  try {
    if (value instanceof ObjectId) return value;
    if (typeof value === "string" && /^[a-f\d]{24}$/i.test(value)) return new ObjectId(value);
  } catch {}
  return null;
};

export { ObjectId };
