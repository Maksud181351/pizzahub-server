import { createRemoteJWKSet, jwtVerify } from "jose";
import { col, toObjectId } from "../db.js";
import { HttpError, asyncHandler } from "../utils.js";

let jwks;
const getJwks = () => {
  if (!jwks) {
    const base = (process.env.BETTER_AUTH_URL || "").replace(/\/$/, "");
    if (!base) throw new Error("BETTER_AUTH_URL is not set");
    jwks = createRemoteJWKSet(new URL(`${base}/api/auth/jwks`), { cooldownDuration: 10_000 });
  }
  return jwks;
};

/**
 * 1) Reads "Authorization: Bearer <jwt>"
 * 2) Verifies signature (Better Auth JWKS), expiry, issuer and audience
 * 3) Loads the user from MongoDB so role / block status are NEVER taken from the client
 */
export const verifyJWT = asyncHandler(async (req, _res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) throw new HttpError(401, "Missing or malformed Authorization header");

  let payload;
  try {
    const origin = new URL(process.env.BETTER_AUTH_URL).origin;
    ({ payload } = await jwtVerify(token, getJwks(), { issuer: origin, audience: origin }));
  } catch (err) {
    const expired = err?.code === "ERR_JWT_EXPIRED";
    throw new HttpError(401, expired ? "Token expired. Please sign in again" : "Invalid token");
  }

  const id = payload.sub || payload.id;
  const users = await col("users");
  const user = (await users.findOne({ _id: toObjectId(id) ?? id })) || null;
  if (!user) throw new HttpError(401, "User not found");
  if (user.isBlocked) throw new HttpError(403, "Your account has been blocked");

  req.user = user; // full DB record, trusted
  next();
});

/** Role based middleware: requireRole("vendor"), requireRole("admin", "customer") ... */
export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, "Unauthorized"));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, "You do not have permission to do this"));
    next();
  };
