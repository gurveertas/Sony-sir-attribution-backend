/**
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) for two-factor login.
 * Works with Google Authenticator, 1Password, Authy, etc.
 */
import crypto from "crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(str) {
    const clean = String(str).toUpperCase().replace(/=+$/g, "").replace(/\s/g, "");
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1) throw new Error("invalid base32");
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20));

export function totp(secret, at = Date.now(), step = 30, digits = 6) {
    const counter = Math.floor(at / 1000 / step);
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString();
    return code.padStart(digits, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret, code, at = Date.now()) {
    const c = String(code ?? "").replace(/\s/g, "");
    if (!/^\d{6}$/.test(c)) return false;
    for (const drift of [-1, 0, 1]) {
        const expected = totp(secret, at + drift * 30_000);
        if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
    }
    return false;
}

export const otpauthUrl = (secret, account, issuer = "Wink Attribution") =>
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
