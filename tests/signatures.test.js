import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { verifyStripeSignature } = await import("../controllers/connectorController.js");
const { verifyHmacSignature } = await import("../utils/connectorConfig.js");

const stripeHeader = (body, secret, ts = Math.floor(Date.now() / 1000)) =>
    `t=${ts},v1=${crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

test("stripe signature: valid, tampered body, wrong secret, stale timestamp", () => {
    const body = '{"id":"evt_1"}';
    assert.equal(verifyStripeSignature(body, stripeHeader(body, "whsec_1"), "whsec_1"), true);
    assert.equal(verifyStripeSignature(body + " ", stripeHeader(body, "whsec_1"), "whsec_1"), false);
    assert.equal(verifyStripeSignature(body, stripeHeader(body, "whsec_1"), "whsec_2"), false);
    assert.equal(verifyStripeSignature(body, stripeHeader(body, "whsec_1", Math.floor(Date.now() / 1000) - 3600), "whsec_1"), false);
    assert.equal(verifyStripeSignature(body, undefined, "whsec_1"), false);
});

test("razorpay-style hex HMAC", () => {
    const body = '{"event":"payment.captured"}';
    const sig = crypto.createHmac("sha256", "s3cret").update(body).digest("hex");
    assert.equal(verifyHmacSignature({ secret: "s3cret", signature: sig, payload: body, encoding: "hex" }), true);
    assert.equal(verifyHmacSignature({ secret: "other", signature: sig, payload: body, encoding: "hex" }), false);
    assert.equal(verifyHmacSignature({ secret: "s3cret", signature: "zz", payload: body, encoding: "hex" }), false);
});
