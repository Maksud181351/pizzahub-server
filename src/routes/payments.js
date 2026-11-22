import { Router } from "express";
import Stripe from "stripe";
import { col } from "../db.js";
import { HttpError, asyncHandler, isPremium, FREE_ITEM_LIMIT } from "../utils.js";
import { verifyJWT, requireRole } from "../middleware/auth.js";

export const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new HttpError(500, "Payments are not configured");
  return new Stripe(process.env.STRIPE_SECRET_KEY);
};

const clientUrl = () => (process.env.CLIENT_URL || "http://localhost:3000").split(",")[0].trim().replace(/\/$/, "");

const router = Router();
router.use(verifyJWT, requireRole("vendor"));

/**
 * Step 2 of the flow: backend creates the Checkout Session.
 * The vendor id comes ONLY from the verified JWT, so nobody can start a session for another vendor.
 * Premium is NOT activated here, only the verified webhook does that.
 */
router.post(
  "/checkout-session",
  asyncHandler(async (req, res) => {
    if (isPremium(req.user)) throw new HttpError(409, "You already have an active Premium subscription");
    const price = Math.round(Number(process.env.PREMIUM_PRICE_USD || 15) * 100);
    const vendorId = String(req.user._id);
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer_email: req.user.email,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: price,
            recurring: { interval: "month" },
            product_data: { name: "PizzaHub Premium", description: "Unlimited menu items, Premium badge and featured placement" },
          },
        },
      ],
      metadata: { vendorId, plan: "premium" },
      subscription_data: { metadata: { vendorId, plan: "premium" } },
      client_reference_id: vendorId,
      success_url: `${clientUrl()}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl()}/payment/cancel`,
    });
    res.json({ url: session.url });
  })
);

// Read-only status used by the success page. It reports what the webhook has recorded.
router.get(
  "/session/:sessionId",
  asyncHandler(async (req, res) => {
    const sessionId = String(req.params.sessionId);
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) throw new HttpError(400, "Invalid session");
    let session;
    try {
      session = await stripe().checkout.sessions.retrieve(sessionId);
    } catch {
      throw new HttpError(404, "Checkout session not found");
    }
    if (session.metadata?.vendorId !== String(req.user._id)) throw new HttpError(403, "This payment belongs to another account");
    const tx = await (await col("transactions")).findOne({ stripeSessionId: sessionId });
    res.json({
      paymentStatus: session.payment_status,
      confirmed: !!tx && tx.status === "paid",
      premiumActive: isPremium(req.user),
      amount: tx?.amount ?? session.amount_total,
      currency: tx?.currency ?? session.currency,
    });
  })
);

router.get(
  "/subscription",
  asyncHandler(async (req, res) => {
    const items = await col("menuItems");
    const activeItems = await items.countDocuments({ vendorId: req.user._id, status: { $in: ["pending", "approved"] } });
    res.json({
      plan: isPremium(req.user) ? "premium" : "free",
      expiresAt: req.user.subscriptionExpiresAt || null,
      cancelAtPeriodEnd: !!req.user.cancelAtPeriodEnd,
      activeItems,
      limit: isPremium(req.user) ? null : FREE_ITEM_LIMIT,
      priceUsd: Number(process.env.PREMIUM_PRICE_USD || 15),
    });
  })
);

// Cancel at the end of the billing period. The webhook downgrades the plan when it really ends.
router.post(
  "/cancel",
  asyncHandler(async (req, res) => {
    if (!isPremium(req.user) || !req.user.stripeSubscriptionId) throw new HttpError(409, "No active subscription to cancel");
    await stripe().subscriptions.update(req.user.stripeSubscriptionId, { cancel_at_period_end: true });
    await (await col("users")).updateOne({ _id: req.user._id }, { $set: { cancelAtPeriodEnd: true } });
    res.json({ success: true });
  })
);

export default router;
