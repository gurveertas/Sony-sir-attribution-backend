import dotenv from 'dotenv';
dotenv.config();

if (!process.env.JWT_SECRET) {
    console.error("jwt secret missing from env");
    throw new Error("jwt secret missing from env");
}
if (!process.env.DATABASE_PUBLIC_URL) {
    console.error("DB url missing from env");
    throw new Error("DB url missing from env");
}
if (!process.env.PORT) {
    console.error("port missing from env");
    throw new Error("port missing from env");
}
if (!process.env.EMAIL_FROM) {
    console.warn("[config] EMAIL_FROM is not set: outgoing emails may be rejected.");
}
if (!process.env.NODE_ENV) {
    console.error("node env missing from env");
    throw new Error("node env missing from env");
}

const ENV = {
    DATABASE_PUBLIC_URL : process.env.DATABASE_PUBLIC_URL,
    JWT_SECRET : process.env.JWT_SECRET,
    PORT : process.env.PORT,
    EMAIL_FROM : process.env.EMAIL_FROM,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_SECURE: process.env.SMTP_SECURE === undefined
        ? undefined
        : String(process.env.SMTP_SECURE).toLowerCase() === "true",
    NODE_ENV: process.env.NODE_ENV,
    // Dedicated key for encrypting stored secrets (gateway credentials, webhook secrets).
    // Optional for backward compatibility: when unset, JWT_SECRET is used (legacy behaviour).
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || null,
    // Public HTTPS base URL of THIS API, used to build the webhook URLs given to payment gateways.
    APP_API_URL: process.env.APP_API_URL ? process.env.APP_API_URL.replace(/\/+$/, "") : null,
}

if (ENV.NODE_ENV === "production") {
    if (!ENV.ENCRYPTION_KEY) {
        console.warn("[config] ENCRYPTION_KEY is not set: stored secrets are encrypted with a key derived from JWT_SECRET. Set a dedicated ENCRYPTION_KEY.");
    }
    if (!ENV.APP_API_URL) {
        console.warn("[config] APP_API_URL is not set: gateway webhook auto-connect will be unavailable.");
    }
}

export default ENV;
// Optional extras (all have safe defaults):
//   IDENTITY_HASH_KEY   secret for keyed (HMAC) hashing of emails/phones; strongly recommended.
//   FRONTEND_URL        base URL of the dashboard, used in emails (verification, invites, resets).
//   REQUIRE_WORKSPACE_APPROVAL=true  new companies wait in "pending" until a platform admin approves.
//   META_APP_ID / META_APP_SECRET, GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN
//                       enable the ad-spend OAuth connections.
//   DISABLE_BACKGROUND_WORKERS=true  do not start the event queue / scheduler in this process.
//   FX_AUTO_SYNC_ENABLED=false       disable the hourly FX feeds (manual uploads remain available).
//   FX_SECONDARY_SOURCE_ENABLED=false  only use ECB rates (no rates for AED, SAR, ... unless uploaded).
ENV.IDENTITY_HASH_KEY = process.env.IDENTITY_HASH_KEY || null;
// asftas.vercel.app (no dash) has no deployment (Vercel answers 404 DEPLOYMENT_NOT_FOUND): never use it.
ENV.FRONTEND_URL = (process.env.FRONTEND_URL || "https://asf-tas.vercel.app").replace(/\/+$/, "");
ENV.REQUIRE_WORKSPACE_APPROVAL = String(process.env.REQUIRE_WORKSPACE_APPROVAL ?? "false").toLowerCase() === "true";
ENV.META_APP_ID = process.env.META_APP_ID || null;
ENV.META_APP_SECRET = process.env.META_APP_SECRET || null;
ENV.GOOGLE_ADS_CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || null;
ENV.GOOGLE_ADS_CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || null;
ENV.GOOGLE_ADS_DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
ENV.DISABLE_BACKGROUND_WORKERS = String(process.env.DISABLE_BACKGROUND_WORKERS ?? "false").toLowerCase() === "true";
if (process.env.VERCEL === "1") ENV.DISABLE_BACKGROUND_WORKERS = true;
ENV.FX_AUTO_SYNC_ENABLED = String(process.env.FX_AUTO_SYNC_ENABLED ?? "true").toLowerCase() !== "false";
// second free public source (fawazahmed0/exchange-api) for currencies the ECB does not publish (AED, SAR, ...)
ENV.FX_SECONDARY_SOURCE_ENABLED = String(process.env.FX_SECONDARY_SOURCE_ENABLED ?? "true").toLowerCase() !== "false";

if (!process.env.FRONTEND_URL) {
    console.warn(`[config] FRONTEND_URL is not set: links in emails (invites, verification, password reset) fall back to ${ENV.FRONTEND_URL} when the request does not say which dashboard it came from. Set FRONTEND_URL to your dashboard's address.`);
}

if (ENV.NODE_ENV === "production" && !ENV.IDENTITY_HASH_KEY) {
    console.warn("[config] IDENTITY_HASH_KEY is not set: emails/phones are hashed with plain SHA-256, which is easy to brute-force for phone numbers. Set a dedicated secret.");
}
