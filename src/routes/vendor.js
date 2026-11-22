import { Router } from "express";
import { col, toObjectId } from "../db.js";
import { HttpError, asyncHandler, validateMenuItem, isPremium, FREE_ITEM_LIMIT } from "../utils.js";
import { verifyJWT, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(verifyJWT, requireRole("vendor"));

const ACTIVE = ["pending", "approved"]; // counts toward the free plan limit

const activeCount = async (vendorId) => (await col("menuItems")).countDocuments({ vendorId, status: { $in: ACTIVE } });

async function assertWithinPlan(user) {
  if (isPremium(user)) return;
  if ((await activeCount(user._id)) >= FREE_ITEM_LIMIT) {
    const e = new HttpError(403, `Free plan allows ${FREE_ITEM_LIMIT} active menu items. Upgrade to Premium for unlimited items`);
    e.code = "PLAN_LIMIT";
    throw e;
  }
}

const mapItem = (d) => ({ ...d, id: String(d._id), vendorId: String(d.vendorId) });

/** Loads an item and verifies the logged-in vendor owns it */
async function ownItem(req) {
  const _id = toObjectId(req.params.id);
  if (!_id) throw new HttpError(400, "Invalid item ID");
  const items = await col("menuItems");
  const item = await items.findOne({ _id });
  if (!item) throw new HttpError(404, "Menu item not found");
  if (String(item.vendorId) !== String(req.user._id)) throw new HttpError(403, "This item belongs to another vendor");
  return { item, items };
}

router.get(
  "/stats",
  asyncHandler(async (req, res) => {
    const items = await col("menuItems");
    const orders = await col("orders");
    const vendorId = req.user._id;
    const [itemStatus, orderStatus] = await Promise.all([
      (await items.aggregate([{ $match: { vendorId } }, { $group: { _id: "$status", n: { $sum: 1 } } }])).toArray(),
      (await orders.aggregate([{ $match: { vendorId } }, { $group: { _id: "$status", n: { $sum: 1 } } }])).toArray(),
    ]);
    const i = Object.fromEntries(itemStatus.map((x) => [x._id, x.n]));
    const o = Object.fromEntries(orderStatus.map((x) => [x._id, x.n]));
    res.json({
      totalItems: Object.values(i).reduce((a, b) => a + b, 0),
      activeItems: (i.pending || 0) + (i.approved || 0),
      approvedItems: i.approved || 0,
      pendingOrders: o.pending || 0,
      acceptedOrders: o.accepted || 0,
      subscriptionPlan: isPremium(req.user) ? "premium" : "free",
      itemsByStatus: ["pending", "approved", "rejected", "inactive"].map((s) => ({ name: s, value: i[s] || 0 })),
      ordersByStatus: ["pending", "accepted", "rejected", "cancelled"].map((s) => ({ name: s, value: o[s] || 0 })),
    });
  })
);

router.get(
  "/menu",
  asyncHandler(async (req, res) => {
    const items = await col("menuItems");
    const docs = await items.find({ vendorId: req.user._id }).sort({ createdAt: -1 }).toArray();
    res.json({ items: docs.map(mapItem), activeCount: docs.filter((d) => ACTIVE.includes(d.status)).length, limit: isPremium(req.user) ? null : FREE_ITEM_LIMIT });
  })
);

router.get(
  "/menu/:id",
  asyncHandler(async (req, res) => {
    const { item } = await ownItem(req);
    res.json({ item: mapItem(item) });
  })
);

router.post(
  "/menu",
  asyncHandler(async (req, res) => {
    const { errors, data } = validateMenuItem(req.body || {});
    if (errors.length) throw new HttpError(400, errors[0]);
    await assertWithinPlan(req.user);
    const items = await col("menuItems");
    const doc = { ...data, vendorId: req.user._id, status: "pending", createdAt: new Date() };
    const { insertedId } = await items.insertOne(doc);
    res.status(201).json({ item: mapItem({ ...doc, _id: insertedId }) });
  })
);

// Editing re-submits the item for admin review (inactive items stay inactive)
router.put(
  "/menu/:id",
  asyncHandler(async (req, res) => {
    const { item, items } = await ownItem(req);
    const { errors, data } = validateMenuItem(req.body || {});
    if (errors.length) throw new HttpError(400, errors[0]);
    let status = item.status === "inactive" ? "inactive" : "pending";
    if (item.status === "rejected") await assertWithinPlan(req.user); // rejected -> pending becomes active again
    await items.updateOne({ _id: item._id, vendorId: req.user._id }, { $set: { ...data, status, updatedAt: new Date() } });
    res.json({ item: mapItem({ ...item, ...data, status }) });
  })
);

// Manage availability: pause / resume an item
router.patch(
  "/menu/:id/availability",
  asyncHandler(async (req, res) => {
    const { item, items } = await ownItem(req);
    const available = req.body?.available === true;
    let set;
    if (!available) {
      if (!ACTIVE.includes(item.status)) throw new HttpError(409, "Only active items can be paused");
      set = { status: "inactive", inactiveBy: "vendor" };
    } else {
      if (item.status === "rejected") throw new HttpError(409, "Rejected items must be edited and re-submitted");
      if (item.status !== "inactive") throw new HttpError(409, "Item is already active");
      if (item.inactiveBy === "admin") throw new HttpError(403, "An admin disabled this item. Contact support");
      await assertWithinPlan(req.user);
      set = { status: item.approvedBefore ? "approved" : "pending" };
    }
    await items.updateOne({ _id: item._id, vendorId: req.user._id }, { $set: { ...set, updatedAt: new Date() } });
    res.json({ item: mapItem({ ...item, ...set }) });
  })
);

router.delete(
  "/menu/:id",
  asyncHandler(async (req, res) => {
    const { item, items } = await ownItem(req);
    await items.deleteOne({ _id: item._id, vendorId: req.user._id });
    res.json({ success: true });
  })
);

export default router;
