import { col } from "./db.js";
import { stripe } from "./routes/payments.js";
import { FREE_ITEM_LIMIT } from "./utils.js";
import { toObjectId } from "./db.js";

const periodEnd = (sub) => {
  const ts = sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end;
  return ts ? new Date(ts * 1000) : new Date(Date.now() + 31 * 864e5);
};
const invoiceSubId = (inv) => {
  const s = inv.subscription ?? inv.parent?.subscription_details?.subscription;
  return typeof s === "string" ? s : s?.id;
};

/** Keep the 3 oldest active items when Premium ends; pause the rest */
async function enforceFreeLimit(vendorId) {
  const items = await col("menuItems");
  const active = await items.find({ vendorId, status: { $in: ["pending", "approved"] } }).sort({ createdAt: 1 }).toArray();
  const extra = active.slice(FREE_ITEM_LIMIT).map((i) => i._id);
  if (extra.length) await items.updateMany({ _id: { $in: extra } }, { $set: { status: "inactive", inactiveBy: "plan" } });
}

/**
 * POST /api/stripe/webhook (raw body). The ONLY place that activates Premium.
 * The signature is verified with STRIPE_WEBHOOK_SECRET, so the event cannot be forged by a client.
 */
export async function stripeWebhook(req, res) {
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    const users = await col("users");
    const tx = await col("transactions");

    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        if (s.payment_status !== "paid") break; // wait for the async payment event
        const vendorId = toObjectId(s.metadata?.vendorId);
        const vendor = vendorId && (await users.findOne({ _id: vendorId, role: "vendor" }));
        if (!vendor) break;
        const sub = s.subscription ? await stripe().subscriptions.retrieve(s.subscription) : null;
        const expires = periodEnd(sub);
        await tx.updateOne(
          { stripeSessionId: s.id },
          { $setOnInsert: { vendorId, plan: "premium", amount: s.amount_total, currency: s.currency, stripeSessionId: s.id, stripeSubscriptionId: s.subscription || null, status: "paid", createdAt: new Date() } },
          { upsert: true }
        );
        await users.updateOne(
          { _id: vendorId },
          { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: expires, stripeSubscriptionId: s.subscription || null, stripeCustomerId: s.customer || null, cancelAtPeriodEnd: false } }
        );
        break;
      }
      case "invoice.paid": {
        const inv = event.data.object;
        if (inv.billing_reason !== "subscription_cycle") break; // first payment is handled above
        const subId = invoiceSubId(inv);
        const vendor = subId && (await users.findOne({ stripeSubscriptionId: subId }));
        if (!vendor) break;
        const sub = await stripe().subscriptions.retrieve(subId);
        await users.updateOne({ _id: vendor._id }, { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: periodEnd(sub) } });
        await tx.updateOne(
          { stripeInvoiceId: inv.id },
          { $setOnInsert: { vendorId: vendor._id, plan: "premium", amount: inv.amount_paid, currency: inv.currency, stripeSessionId: null, stripeInvoiceId: inv.id, stripeSubscriptionId: subId, status: "paid", createdAt: new Date() } },
          { upsert: true }
        );
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const subId = invoiceSubId(inv);
        const vendor = subId && (await users.findOne({ stripeSubscriptionId: subId }));
        if (!vendor) break;
        await tx.updateOne(
          { stripeInvoiceId: inv.id },
          { $setOnInsert: { vendorId: vendor._id, plan: "premium", amount: inv.amount_due, currency: inv.currency, stripeSessionId: null, stripeInvoiceId: inv.id, stripeSubscriptionId: subId, status: "failed", createdAt: new Date() } },
          { upsert: true }
        );
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const vendor = await users.findOne({ stripeSubscriptionId: sub.id });
        if (!vendor) break;
        const set = { cancelAtPeriodEnd: !!sub.cancel_at_period_end };
        if (["active", "trialing"].includes(sub.status)) set.subscriptionExpiresAt = periodEnd(sub);
        await users.updateOne({ _id: vendor._id }, { $set: set });
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const vendor = await users.findOne({ stripeSubscriptionId: sub.id });
        if (!vendor) break;
        await users.updateOne({ _id: vendor._id }, { $set: { subscriptionPlan: "free", subscriptionExpiresAt: null, cancelAtPeriodEnd: false } });
        await enforceFreeLimit(vendor._id);
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    res.status(500).json({ error: "Webhook handler failed" }); // Stripe will retry
  }
}
