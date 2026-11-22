export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const CATEGORIES = [
  "Classic Pizzas",
  "Vegetarian Pizzas",
  "Meat Lovers",
  "Specialty / Gourmet Pizzas",
  "Sides & Appetizers",
  "Beverages & Desserts",
];

export const FREE_ITEM_LIMIT = 3;

/** Premium only counts while the subscription has not expired */
export function isPremium(user) {
  if (!user || user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

export const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const str = (v) => (typeof v === "string" ? v.trim() : "");

/** Safe public projection of a user */
export function publicUser(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    name: u.name,
    email: u.email,
    image: u.image || null,
    role: u.role,
    isBlocked: !!u.isBlocked,
    businessName: u.businessName || null,
    subscriptionPlan: isPremium(u) ? "premium" : "free",
    subscriptionExpiresAt: u.subscriptionExpiresAt || null,
    createdAt: u.createdAt,
  };
}

/** Public vendor card info (no email) */
export function vendorInfo(u) {
  if (!u) return null;
  return {
    id: String(u._id),
    name: u.name,
    image: u.image || null,
    businessName: u.businessName || u.name,
    isPremium: isPremium(u),
  };
}

export function validateMenuItem(body, { partial = false } = {}) {
  const errors = [];
  const out = {
    itemName: str(body.itemName),
    category: str(body.category),
    description: str(body.description),
    location: str(body.location),
    price: Number(body.price),
    images: Array.isArray(body.images) ? body.images.filter((i) => typeof i === "string" && /^https?:\/\//.test(i)).slice(0, 5) : [],
  };
  if (out.itemName.length < 2 || out.itemName.length > 80) errors.push("Item name must be 2-80 characters");
  if (!CATEGORIES.includes(out.category)) errors.push("Choose a valid category");
  if (out.description.length < 10 || out.description.length > 1000) errors.push("Description must be 10-1000 characters");
  if (out.location.length < 2 || out.location.length > 80) errors.push("Location is required");
  if (!Number.isFinite(out.price) || out.price <= 0 || out.price > 10000) errors.push("Price must be a positive number");
  if (!partial && out.images.length === 0) errors.push("At least one image is required");
  if (partial && out.images.length === 0) errors.push("At least one image is required");
  return { errors, data: out };
}
