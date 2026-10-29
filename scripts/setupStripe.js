/**
 * Stripe Billing Setup Script
 *
 * Verifies your Stripe Secret Key and creates the Pro & Ultra products
 * and recurring prices in your Stripe account automatically.
 *
 * Usage:
 *   node scripts/setupStripe.js
 * Or with key directly:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setupStripe.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ENV from "../utils/env.js";
import { PLANS, PLAN_TIERS } from "../config/plans.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");

const STRIPE_BASE = "https://api.stripe.com/v1";

async function stripeRequest(endpoint, params = {}, method = "POST", secretKey = ENV.STRIPE_SECRET_KEY) {
    const isGet = method === "GET";
    let url = `${STRIPE_BASE}${endpoint}`;
    let body = undefined;

    if (isGet && Object.keys(params).length) {
        url += `?${new URLSearchParams(params).toString()}`;
    } else if (!isGet) {
        body = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) body.append(k, String(v));
        }
    }

    const res = await fetch(url, {
        method,
        headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: isGet ? undefined : body?.toString(),
    });

    const data = await res.json();
    if (!res.ok) {
        const msg = data?.error?.message || `Stripe request failed with status ${res.status}`;
        throw new Error(msg);
    }
    return data;
}

async function run() {
    console.log("==================================================");
    console.log("      Stripe Billing Automation & Setup");
    console.log("==================================================\n");

    const key = process.env.STRIPE_SECRET_KEY || ENV.STRIPE_SECRET_KEY;
    if (!key) {
        console.error("❌ ERROR: STRIPE_SECRET_KEY is not defined.");
        console.log("\nPlease add your Stripe secret key to your .env file:");
        console.log("  STRIPE_SECRET_KEY=sk_test_51...\n");
        console.log("Or run this script passing it inline:");
        console.log("  STRIPE_SECRET_KEY=sk_test_... node scripts/setupStripe.js\n");
        process.exit(1);
    }

    console.log(`🔑 Using key: ${key.slice(0, 7)}...${key.slice(-4)}`);

    // 1. Verify connection
    try {
        const account = await stripeRequest("/account", {}, "GET", key);
        console.log(`✅ Connected to Stripe Account: ${account.business_profile?.name || account.id} (${account.country})`);
    } catch (err) {
        console.error(`❌ Stripe authentication failed: ${err.message}`);
        process.exit(1);
    }

    // 2. Setup Pro and Ultra Products & Prices
    const priceResults = {};

    const configs = [
        {
            tier: PLAN_TIERS.PRO,
            name: PLANS[PLAN_TIERS.PRO].name,
            description: PLANS[PLAN_TIERS.PRO].description,
            monthlyAmount: PLANS[PLAN_TIERS.PRO].pricing.monthly * 100, // in cents
            annuallyAmount: PLANS[PLAN_TIERS.PRO].pricing.annually * 100,
        },
        {
            tier: PLAN_TIERS.ULTRA,
            name: PLANS[PLAN_TIERS.ULTRA].name,
            description: PLANS[PLAN_TIERS.ULTRA].description,
            monthlyAmount: PLANS[PLAN_TIERS.ULTRA].pricing.monthly * 100,
            annuallyAmount: PLANS[PLAN_TIERS.ULTRA].pricing.annually * 100,
        },
    ];

    for (const c of configs) {
        console.log(`\n📦 Checking product: "${c.name}"...`);

        // Check if product exists
        const existingProducts = await stripeRequest("/products", { limit: 100 }, "GET", key);
        let product = existingProducts.data.find(
            (p) => p.name.toLowerCase() === c.name.toLowerCase() || p.metadata?.tier === c.tier
        );

        if (!product) {
            console.log(`   Creating product: "${c.name}"...`);
            product = await stripeRequest("/products", {
                name: c.name,
                description: c.description,
                "metadata[tier]": c.tier,
            }, "POST", key);
            console.log(`   ✅ Created product: ${product.id}`);
        } else {
            console.log(`   ℹ️ Product already exists: ${product.id}`);
        }

        // Monthly Price
        console.log(`   Creating/finding monthly recurring price ($${c.monthlyAmount / 100}/mo)...`);
        const monthlyPrice = await stripeRequest("/prices", {
            product: product.id,
            unit_amount: c.monthlyAmount,
            currency: "usd",
            "recurring[interval]": "month",
            "metadata[tier]": c.tier,
            "metadata[interval]": "monthly",
        }, "POST", key);
        console.log(`   ✅ Monthly Price ID: ${monthlyPrice.id}`);
        priceResults[`STRIPE_PRICE_ID_${c.tier.toUpperCase()}_MONTHLY`] = monthlyPrice.id;

        // Annually Price
        console.log(`   Creating/finding annual recurring price ($${c.annuallyAmount / 100}/yr)...`);
        const annuallyPrice = await stripeRequest("/prices", {
            product: product.id,
            unit_amount: c.annuallyAmount,
            currency: "usd",
            "recurring[interval]": "year",
            "metadata[tier]": c.tier,
            "metadata[interval]": "annually",
        }, "POST", key);
        console.log(`   ✅ Annual Price ID: ${annuallyPrice.id}`);
        priceResults[`STRIPE_PRICE_ID_${c.tier.toUpperCase()}_ANNUALLY`] = annuallyPrice.id;
    }

    console.log("\n==================================================");
    console.log("           Configuration Summary");
    console.log("==================================================\n");

    for (const [k, v] of Object.entries(priceResults)) {
        console.log(`${k}=${v}`);
    }

    // 3. Update .env file automatically
    if (fs.existsSync(envPath)) {
        let envContent = fs.readFileSync(envPath, "utf-8");
        let modified = false;

        for (const [k, v] of Object.entries(priceResults)) {
            const regex = new RegExp(`^${k}=.*$`, "m");
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${k}=${v}`);
                modified = true;
            } else {
                envContent += `\n${k}=${v}`;
                modified = true;
            }
        }

        if (modified) {
            fs.writeFileSync(envPath, envContent.trim() + "\n", "utf-8");
            console.log(`\n✅ Successfully updated ${envPath} with the generated Stripe price IDs!`);
        }
    }

    console.log("\n🎉 Stripe billing setup complete! Your backend is ready to handle real payments.");
}

run().catch((err) => {
    console.error("\n❌ Unexpected setup error:", err.message);
    process.exit(1);
});

