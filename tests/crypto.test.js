import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

test("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import("../utils/crypto.js");
    const enc = encryptSecret("whsec_abc");
    assert.notEqual(enc.toString("utf8"), "whsec_abc");
    assert.equal(decryptSecret(enc), "whsec_abc");
});

test("secrets stored with the legacy JWT_SECRET key still decrypt after ENCRYPTION_KEY is introduced", () => {
    // Re-implement the legacy encryption exactly as it was, then load a fresh module with ENCRYPTION_KEY set.
    const legacyKey = crypto.createHash("sha256").update("test-jwt-secret").digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    const body = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), body]);

    return import("node:child_process").then(({ execFileSync }) => {
        const out = execFileSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { decryptSecret, encryptSecret } from "./utils/crypto.js";
                 const legacy = Buffer.from("${legacy.toString("base64")}", "base64");
                 const fresh = encryptSecret("new-secret");
                 console.log(JSON.stringify([decryptSecret(legacy), decryptSecret(fresh)]));`,
            ],
            { env: { ...process.env, ENCRYPTION_KEY: "a-dedicated-encryption-key" }, cwd: process.cwd() },
        ).toString();
        assert.deepEqual(JSON.parse(out), ["legacy-secret", "new-secret"]);
    });
});
