import { Router } from "express";
import { col } from "../db.js";
import { HttpError, asyncHandler, publicUser } from "../utils.js";
import { verifyJWT } from "../middleware/auth.js";

const router = Router();
router.use(verifyJWT);

router.get("/me", (req, res) => res.json({ user: publicUser(req.user) }));

/**
 * One-time role choice for accounts created with Google (they start as "customer", onboarded=false).
 * Admin can never be chosen here, and the role cannot be changed again afterwards.
 */
router.post(
  "/me/onboard",
  asyncHandler(async (req, res) => {
    const role = req.body?.role;
    if (!["vendor", "customer"].includes(role)) throw new HttpError(400, "Role must be vendor or customer");
    if (req.user.onboarded !== false) throw new HttpError(409, "Account type is already set");
    const set = { role, onboarded: true, updatedAt: new Date() };
    const businessName = typeof req.body?.businessName === "string" ? req.body.businessName.trim().slice(0, 80) : "";
    if (role === "vendor" && businessName) set.businessName = businessName;
    const users = await col("users");
    await users.updateOne({ _id: req.user._id, onboarded: false }, { $set: set });
    res.json({ user: publicUser({ ...req.user, ...set }) });
  })
);

export default router;
