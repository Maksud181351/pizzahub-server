import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import menuRoutes from "./routes/menu.js";
import vendorRoutes from "./routes/vendor.js";
import orderRoutes from "./routes/orders.js";
import adminRoutes from "./routes/admin.js";
import userRoutes from "./routes/users.js";
import paymentRoutes from "./routes/payments.js";
import { stripeWebhook } from "./webhook.js";

const app = express();
const allowed = (process.env.CLIENT_URL || "http://localhost:3000").split(",").map((s) => s.trim().replace(/\/$/, ""));

app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => (!origin || allowed.includes(origin) ? cb(null, true) : cb(null, false)),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Stripe needs the RAW body to verify the signature, so this route comes BEFORE express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhook);

app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => res.json({ name: "PizzaHub API", status: "ok" }));
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/menu", menuRoutes);
app.use("/api/vendor", vendorRoutes);
app.use("/api", orderRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/payments", paymentRoutes);

app.use((req, res) => res.status(404).json({ error: `Route ${req.method} ${req.originalUrl} not found` }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? "Something went wrong on the server" : err.message, ...(err.code ? { code: err.code } : {}) });
});

if (!process.env.VERCEL) {
  const port = process.env.PORT || 5000;
  app.listen(port, () => console.log(`PizzaHub API listening on :${port}`));
}

export default app;
