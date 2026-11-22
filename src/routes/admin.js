import { Router } from "express";
import { col, toObjectId } from "../db.js";
import { HttpError, asyncHandler, escapeRegex, str, publicUser, vendorInfo, CATEGORIES } from "../utils.js";
import { verifyJWT, requireRole } from "../middleware/auth.js";

const router = Router();
router.use(verifyJWT, requireRole("admin"));

router.get(
  "/stats",
  asyncHandler(async (_req, res) => {
    const users = await col("users");
    const items = await col("menuItems");
    const tx = await col("transactions");
    const [roles, itemStatus, revenue, totalTx] = await Promise.all([
      (await users.aggregate([{ $group: { _id: "$role", n: { $sum: 1 } } }])).toArray(),
      (await items.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])).toArray(),
      (await tx.aggregate([{ $match: { status: "paid" } }, { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, total: { $sum: "$amount" } } }, { $sort: { _id: 1 } }, { $limit: 12 }])).toArray(),
      tx.countDocuments(),
    ]);
    const r = Object.fromEntries(roles.map((x) => [x._id, x.n]));
    const i = Object.fromEntries(itemStatus.map((x) => [x._id, x.n]));
    res.json({
      totalUsers: Object.values(r).reduce((a, b) => a + b, 0),
      totalVendors: r.vendor || 0,
      totalCustomers: r.customer || 0,
      totalMenuItems: Object.values(i).reduce((a, b) => a + b, 0),
      pendingMenuItems: i.pending || 0,
      totalTransactions: totalTx,
      usersByRole: ["vendor", "customer", "admin"].map((n) => ({ name: n, value: r[n] || 0 })),
      itemsByStatus: ["pending", "approved", "rejected", "inactive"].map((n) => ({ name: n, value: i[n] || 0 })),
      revenueByMonth: revenue.map((x) => ({ name: x._id, value: x.total / 100 })),
    });
  })
);

/* ---------- Users ---------- */
router.get(
  "/users",
  asyncHandler(async (req, res) => {
    const users = await col("users");
    const q = {};
    const search = str(req.query.search);
    if (search) {
      const r = { $regex: escapeRegex(search), $options: "i" };
      q.$or = [{ name: r }, { email: r }];
    }
    if (["vendor", "customer", "admin"].includes(req.query.role)) q.role = req.query.role;
    const docs = await users.find(q).sort({ createdAt: -1 }).limit(200).toArray();
    res.json({ users: docs.map(publicUser) });
  })
);

router.get(
  "/users/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid user ID");
    const users = await col("users");
    const u = await users.findOne({ _id });
    if (!u) throw new HttpError(404, "User not found");
    const items = await col("menuItems");
    const orders = await col("orders");
    const [menuItems, ordersCount] = await Promise.all([items.countDocuments({ vendorId: _id }), orders.countDocuments({ $or: [{ customerId: _id }, { vendorId: _id }] })]);
    res.json({ user: publicUser(u), menuItems, orders: ordersCount });
  })
);

router.patch(
  "/users/:id/block",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid user ID");
    if (typeof req.body?.blocked !== "boolean") throw new HttpError(400, "blocked must be true or false");
    const users = await col("users");
    const target = await users.findOne({ _id });
    if (!target) throw new HttpError(404, "User not found");
    if (target.role === "admin") throw new HttpError(403, "Admin accounts cannot be blocked");
    await users.updateOne({ _id }, { $set: { isBlocked: req.body.blocked, updatedAt: new Date() } });
    if (req.body.blocked) {
      // kill their live sessions so the block takes effect immediately
      await (await col("session")).deleteMany({ userId: { $in: [_id, String(_id)] } });
    }
    res.json({ user: publicUser({ ...target, isBlocked: req.body.blocked }) });
  })
);

/* ---------- Menu items ---------- */
const shape = (d) => {
  const { vendor, _id, vendorId, ...rest } = d;
  return { ...rest, id: String(_id), vendorId: String(vendorId), vendor: vendorInfo(vendor) };
};

router.get(
  "/menu",
  asyncHandler(async (req, res) => {
    const items = await col("menuItems");
    const match = {};
    if (["pending", "approved", "rejected", "inactive"].includes(req.query.status)) match.status = req.query.status;
    if (CATEGORIES.includes(req.query.category)) match.category = req.query.category;
    const search = str(req.query.search);
    if (search) {
      const r = { $regex: escapeRegex(search), $options: "i" };
      match.$or = [{ itemName: r }, { location: r }];
    }
    const docs = await (
      await items.aggregate([
        { $match: match },
        { $sort: { createdAt: -1 } },
        { $limit: 300 },
        { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
        { $addFields: { vendor: { $first: "$vendor" } } },
      ])
    ).toArray();
    res.json({ items: docs.map(shape) });
  })
);

router.patch(
  "/menu/:id/status",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid item ID");
    const status = req.body?.status;
    if (!["pending", "approved", "rejected", "inactive"].includes(status)) throw new HttpError(400, "Invalid status");
    const items = await col("menuItems");
    const set = { status, reviewedBy: req.user._id, updatedAt: new Date() };
    const unset = {};
    if (status === "approved") {
      set.approvedBefore = true;
      unset.inactiveBy = "";
    }
    if (status === "inactive") set.inactiveBy = "admin";
    const r = await items.updateOne({ _id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
    if (!r.matchedCount) throw new HttpError(404, "Menu item not found");
    res.json({ success: true, status });
  })
);

router.delete(
  "/menu/:id",
  asyncHandler(async (req, res) => {
    const _id = toObjectId(req.params.id);
    if (!_id) throw new HttpError(400, "Invalid item ID");
    const items = await col("menuItems");
    const r = await items.deleteOne({ _id });
    if (!r.deletedCount) throw new HttpError(404, "Menu item not found");
    res.json({ success: true });
  })
);

/* ---------- Transactions: READ ONLY (no write route exists on purpose) ---------- */
router.get(
  "/transactions",
  asyncHandler(async (_req, res) => {
    const tx = await col("transactions");
    const docs = await (
      await tx.aggregate([
        { $sort: { createdAt: -1 } },
        { $limit: 300 },
        { $lookup: { from: "users", localField: "vendorId", foreignField: "_id", as: "vendor" } },
        { $addFields: { vendor: { $first: "$vendor" } } },
      ])
    ).toArray();
    res.json({
      transactions: docs.map((t) => ({
        id: String(t._id),
        plan: t.plan,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        stripeSessionId: t.stripeSessionId || null,
        createdAt: t.createdAt,
        vendor: t.vendor ? { id: String(t.vendor._id), name: t.vendor.name, email: t.vendor.email, businessName: t.vendor.businessName || null } : null,
      })),
    });
  })
);

export default router;
