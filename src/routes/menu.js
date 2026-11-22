import { Router } from "express";
import { col, toObjectId } from "../db.js";
import { HttpError, asyncHandler, escapeRegex, str, vendorInfo, CATEGORIES } from "../utils.js";

const router = Router();

const PREMIUM_EXPR = {
  $and: [
    { $eq: ["$vendor.subscriptionPlan", "premium"] },
    { $or: [{ $eq: [{ $ifNull: ["$vendor.subscriptionExpiresAt", null] }, null] }, { $gt: ["$vendor.subscriptionExpiresAt", "$$NOW"] }] },
  ],
};

export const shapeItem = (d) => {
  const { vendor, vendorPremium, _id, vendorId, ...rest } = d;
  return { ...rest, id: String(_id), vendorId: String(vendorId), vendor: vendorInfo(vendor) };
};

/** approved items whose vendor is not blocked, with vendor joined */
const publicBase = (match = {}) => [
  { $match: { status: "approved", ...match } },
  { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
  { $unwind: "$vendor" },
  { $match: { "vendor.isBlocked": { $ne: true } } },
  { $addFields: { vendorPremium: PREMIUM_EXPR } },
];

/**
 * GET /api/menu
 * Query: search, category, location, minPrice, maxPrice, sort (price_asc|price_desc|newest), page, limit
 * - search is multi-word: every word must match name, description, category, location or vendor
 */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit) || 9));
    const match = {};
    const category = str(req.query.category);
    if (category) match.category = category;
    const location = str(req.query.location);
    if (location) match.location = { $regex: escapeRegex(location), $options: "i" };
    const min = Number(req.query.minPrice);
    const max = Number(req.query.maxPrice);
    if (req.query.minPrice && Number.isFinite(min)) (match.price ??= {}).$gte = min;
    if (req.query.maxPrice && Number.isFinite(max)) (match.price ??= {}).$lte = max;

    const terms = str(req.query.search).split(/\s+/).filter(Boolean).slice(0, 6);
    const searchMatch = terms.length
      ? {
          $and: terms.map((t) => {
            const r = { $regex: escapeRegex(t), $options: "i" };
            return { $or: [{ itemName: r }, { description: r }, { category: r }, { location: r }, { "vendor.businessName": r }, { "vendor.name": r }] };
          }),
        }
      : {};

    const sorts = {
      price_asc: { price: 1, _id: 1 },
      price_desc: { price: -1, _id: 1 },
      newest: { createdAt: -1, _id: 1 },
    };
    const sort = sorts[req.query.sort] || { vendorPremium: -1, createdAt: -1, _id: 1 };

    const items = await col("menuItems");
    const [result] = await (
      await items.aggregate([
        ...publicBase(match),
        { $match: searchMatch },
        { $sort: sort },
        { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: "n" }] } },
      ])
    ).toArray();
    const total = result.total[0]?.n || 0;
    res.json({ items: result.items.map(shapeItem), total, page, pages: Math.ceil(total / limit) || 1 });
  })
);

router.get(
  "/featured",
  asyncHandler(async (req, res) => {
    const limit = Math.min(12, Math.max(1, parseInt(req.query.limit) || 6));
    const items = await col("menuItems");
    const docs = await (await items.aggregate([...publicBase(), { $sort: { vendorPremium: -1, createdAt: -1 } }, { $limit: limit }])).toArray();
    res.json({ items: docs.map(shapeItem) });
  })
);

router.get(
  "/meta",
  asyncHandler(async (_req, res) => {
    const items = await col("menuItems");
    const locations = (await items.distinct("location", { status: "approved" })).sort();
    const counts = await (await items.aggregate([{ $match: { status: "approved" } }, { $group: { _id: "$category", n: { $sum: 1 } } }])).toArray();
    const byCategory = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    res.json({ locations, categories: CATEGORIES.map((name) => ({ name, count: byCategory[name] || 0 })) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid item ID");
    const items = await col("menuItems");
    const [doc] = await (await items.aggregate([...publicBase({ _id })])).toArray();
    if (!doc) throw new HttpError(404, "This menu item does not exist or is no longer available");
    res.json({ item: shapeItem(doc) });
  })
);

export default router;
