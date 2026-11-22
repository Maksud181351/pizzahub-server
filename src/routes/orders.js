import { Router } from "express";
import { col, toObjectId } from "../db.js";
import { HttpError, asyncHandler, str, vendorInfo } from "../utils.js";
import { verifyJWT, requireRole } from "../middleware/auth.js";

const router = Router();
const ORDER_STATUSES = ["pending", "accepted", "rejected", "cancelled"];

/** Orders with item, vendor and customer joined */
const orderPipeline = (match) => [
  { $match: match },
  { $sort: { createdAt: -1 } },
  { $lookup: { from: "menuItems", localField: "itemId", foreignField: "_id", as: "item" } },
  { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
  { $lookup: { from: "users", localField: "customerId", foreignField: "_id", as: "customer" } },
  { $addFields: { item: { $first: "$item" }, vendor: { $first: "$vendor" }, customer: { $first: "$customer" } } },
];

const shapeOrder = (o) => ({
  id: String(o._id),
  status: o.status,
  deliveryDate: o.deliveryDate,
  deliveryAddress: o.deliveryAddress,
  message: o.message || "",
  createdAt: o.createdAt,
  updatedAt: o.updatedAt || null,
  item: o.item ? { id: String(o.item._id), itemName: o.item.itemName, image: o.item.images?.[0] || null, price: o.item.price, category: o.item.category } : null,
  vendor: vendorInfo(o.vendor),
  customer: o.customer ? { id: String(o.customer._id), name: o.customer.name, email: o.customer.email, image: o.customer.image || null } : null,
});

const validDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/* ---------------- Customer ---------------- */
router.post(
  "/orders",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const itemId = toObjectId(req.body?.itemId);
    if (!itemId) throw new HttpError(400, "Invalid item ID");
    const deliveryDate = str(req.body?.deliveryDate);
    const deliveryAddress = str(req.body?.deliveryAddress);
    const message = str(req.body?.message).slice(0, 500);
    if (!validDate(deliveryDate)) throw new HttpError(400, "Choose a valid delivery date");
    // tolerate timezone differences: accept anything from "yesterday UTC" onwards
    const earliest = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (deliveryDate < earliest) throw new HttpError(400, "Delivery date cannot be in the past");
    if (deliveryAddress.length < 8 || deliveryAddress.length > 250) throw new HttpError(400, "Enter a full delivery address (8-250 characters)");

    const items = await col("menuItems");
    const users = await col("users");
    const orders = await col("orders");
    const item = await items.findOne({ _id: itemId });
    if (!item || item.status !== "approved") throw new HttpError(404, "This item is not available for ordering");
    const vendor = await users.findOne({ _id: item.vendorId });
    if (!vendor || vendor.isBlocked) throw new HttpError(404, "This restaurant is not available right now");
    if (String(item.vendorId) === String(req.user._id)) throw new HttpError(403, "You cannot order your own menu item");

    const dup = await orders.findOne({ customerId: req.user._id, itemId, deliveryDate, status: { $in: ["pending", "accepted"] } });
    if (dup) throw new HttpError(409, "You already have an active order for this item on that date");

    const doc = { itemId, vendorId: item.vendorId, customerId: req.user._id, deliveryDate, deliveryAddress, message, status: "pending", createdAt: new Date() };
    const { insertedId } = await orders.insertOne(doc);
    res.status(201).json({ order: { id: String(insertedId), status: "pending" } });
  })
);

router.get(
  "/orders/mine",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const orders = await col("orders");
    const match = { customerId: req.user._id };
    if (ORDER_STATUSES.includes(req.query.status)) match.status = req.query.status;
    res.json({ orders: (await (await orders.aggregate(orderPipeline(match))).toArray()).map(shapeOrder) });
  })
);

router.get(
  "/orders/stats",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const orders = await col("orders");
    const rows = await (await orders.aggregate([{ $match: { customerId: req.user._id } }, { $group: { _id: "$status", n: { $sum: 1 } } }])).toArray();
    const o = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    res.json({
      total: Object.values(o).reduce((a, b) => a + b, 0),
      pending: o.pending || 0,
      accepted: o.accepted || 0,
      rejected: o.rejected || 0,
      cancelled: o.cancelled || 0,
      byStatus: ORDER_STATUSES.map((s) => ({ name: s, value: o[s] || 0 })),
    });
  })
);

// Order details: only the customer or vendor involved (or an admin) may read it
router.get(
  "/orders/:id",
  verifyJWT,
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid order ID");
    const orders = await col("orders");
    const [o] = await (await orders.aggregate(orderPipeline({ _id }))).toArray();
    if (!o) throw new HttpError(404, "Order not found");
    const me = String(req.user._id);
    if (![String(o.customerId), String(o.vendorId)].includes(me) && req.user.role !== "admin") throw new HttpError(403, "You cannot view this order");
    res.json({ order: shapeOrder(o) });
  })
);

router.patch(
  "/orders/:id/cancel",
  verifyJWT,
  requireRole("customer"),
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid order ID");
    const orders = await col("orders");
    // atomic: only the owner's PENDING order can be cancelled
    const r = await orders.updateOne({ _id, customerId: req.user._id, status: "pending" }, { $set: { status: "cancelled", updatedAt: new Date() } });
    if (r.matchedCount === 0) {
      const o = await orders.findOne({ _id });
      if (!o) throw new HttpError(404, "Order not found");
      if (String(o.customerId) !== String(req.user._id)) throw new HttpError(403, "This order belongs to another customer");
      throw new HttpError(409, `This order is already ${o.status} and cannot be cancelled`);
    }
    res.json({ success: true, status: "cancelled" });
  })
);

/* ---------------- Vendor ---------------- */
router.get(
  "/vendor/orders",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const orders = await col("orders");
    const match = { vendorId: req.user._id };
    if (ORDER_STATUSES.includes(req.query.status)) match.status = req.query.status;
    res.json({ orders: (await (await orders.aggregate(orderPipeline(match))).toArray()).map(shapeOrder) });
  })
);

router.patch(
  "/vendor/orders/:id/status",
  verifyJWT,
  requireRole("vendor"),
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid order ID");
    const status = req.body?.status;
    if (!["accepted", "rejected"].includes(status)) throw new HttpError(400, "Status must be accepted or rejected");
    const orders = await col("orders");
    // atomic + ownership: only this vendor's PENDING order, decided exactly once
    const r = await orders.updateOne({ _id, vendorId: req.user._id, status: "pending" }, { $set: { status, updatedAt: new Date() } });
    if (r.matchedCount === 0) {
      const o = await orders.findOne({ _id });
      if (!o) throw new HttpError(404, "Order not found");
      if (String(o.vendorId) !== String(req.user._id)) throw new HttpError(403, "This order belongs to another restaurant");
      throw new HttpError(409, `This order is already ${o.status}`);
    }
    res.json({ success: true, status });
  })
);

export default router;
