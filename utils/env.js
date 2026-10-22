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
if (!process.env.RESEND_API_KEY) {
    console.error("resend api missing from env");
    throw new Error("resend api missing from env");
}
if (!process.env.PORT) {
    console.error("from email missing from env");
    throw new Error("from email missing from env");
}
if (!process.env.NODE_ENV) {
    console.error("node env missing from env");
    throw new Error("node env missing from env");
}

const ENV = {
    DATABASE_PUBLIC_URL : process.env.DATABASE_PUBLIC_URL,
    JWT_SECRET : process.env.JWT_SECRET,
    PORT : process.env.PORT,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    EMAIL_FROM : process.env.EMAIL_FROM,
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