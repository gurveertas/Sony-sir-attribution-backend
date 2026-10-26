/**
 * Identity resolution (scope 4.5, DFD process 5.0) — deterministic rules only.
 *
 *   1. Emails and phones are normalised, then hashed. With IDENTITY_HASH_KEY set the hash is a
 *      per-company keyed HMAC (cannot be brute-forced without the key, and differs per company);
 *      otherwise it is plain SHA-256 (legacy). Lookups always try both, and a record found by its
 *      legacy hash is upgraded in place, so turning the key on later needs no downtime.
 *   2. Match order: email, then phone, then the source system's external customer id.
 *   3. A merged customer is never returned: the merge chain is followed to the surviving record.
 *   4. No identifiers -> no customer (anonymous orders are not turned into fake customers).
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { encryptSecret } from "../utils/crypto.js";
import ENV from "../utils/env.js";

export const normalizeEmail = (value) => {
    if (value === null || value === undefined) return null;
    const v = String(value).trim().toLowerCase();
    return v.includes("@") && v.length <= 320 ? v : null;
};

/** Keeps digits (and a leading +). "00" international prefix becomes "+". Too short -> null. */
export const normalizePhone = (value) => {
    if (value === null || value === undefined) return null;
    let v = String(value).trim();
    if (v.startsWith("00")) v = `+${v.slice(2)}`;
    const plus = v.startsWith("+");
    const digits = v.replace(/\D/g, "");
    if (digits.length < 6 || digits.length > 18) return null;
    return plus ? `+${digits}` : digits;
};

/** Legacy hash: SHA-256 of the trimmed, lower-cased raw value. Kept for matching old rows. */
export const hashIdentifier = (value) =>
    crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");

/** Current hash of a NORMALISED value for a company. */
export const keyedHash = (normalizedValue, workspaceId) =>
    ENV.IDENTITY_HASH_KEY
        ? crypto.createHmac("sha256", ENV.IDENTITY_HASH_KEY).update(`${workspaceId}:${normalizedValue}`).digest("hex")
        : hashIdentifier(normalizedValue);

/** Every hash under which this identifier may have been stored (current first). */
function candidateHashes(raw, normalized, workspaceId) {
    const set = new Set([keyedHash(normalized, workspaceId), hashIdentifier(normalized), hashIdentifier(raw)]);
    return [...set];
}

async function followMerge(orm, customer) {
    let current = customer;
    for (let i = 0; current?.mergedIntoId && i < 10; i++) {
        const next = await orm.Customer.where({ id: current.mergedIntoId, workspaceId: current.workspaceId }).first();
        if (!next) break;
        current = next;
    }
    return current;
}

async function findByHash(orm, workspaceId, field, hashes) {
    for (const h of hashes) {
        const found = await orm.Customer.where({ workspaceId, [field]: h }).first();
        if (found) return found;
    }
    return null;
}

const readExternalIds = (c) => {
    if (!c?.externalIds) return {};
    try {
        return typeof c.externalIds === "string" ? JSON.parse(c.externalIds) : c.externalIds;
    } catch {
        return {};
    }
};

/**
 * Resolve (and optionally create) the customer for a set of identifiers.
 *
 * @param {object} client     db or transaction client
 * @param {string} workspaceId
 * @param {{email?, phone?, externalId?, externalIdKey?}} identifiers
 * @param {{create?: boolean}} options
 * @returns {Promise<{customer: object|null, isNew: boolean, matchedBy: "email"|"phone"|"external_id"|null}>}
 */
export async function resolveCustomer(client, workspaceId, identifiers = {}, { create = true } = {}) {
    const orm = client.orm.public;
    const email = normalizeEmail(identifiers.email);
    const phone = normalizePhone(identifiers.phone);
    const externalId = identifiers.externalId ? String(identifiers.externalId) : null;
    const externalIdKey = identifiers.externalIdKey || "default";

    if (!email && !phone && !externalId) return { customer: null, isNew: false, matchedBy: null };

    const emailHashes = email ? candidateHashes(identifiers.email, email, workspaceId) : [];
    const phoneHashes = phone ? candidateHashes(identifiers.phone, phone, workspaceId) : [];
    const emailHash = email ? keyedHash(email, workspaceId) : null;
    const phoneHash = phone ? keyedHash(phone, workspaceId) : null;

    let found = null;
    let matchedBy = null;
    if (email) {
        found = await findByHash(orm, workspaceId, "emailHash", emailHashes);
        if (found) matchedBy = "email";
    }
    if (!found && phone) {
        found = await findByHash(orm, workspaceId, "phoneHash", phoneHashes);
        if (found) matchedBy = "phone";
    }
    if (!found && externalId) {
        // externalIds is a small JSON map per customer; scan only when an external id is given.
        const all = await orm.Customer.where({ workspaceId }).all();
        found = all.find((c) => readExternalIds(c)[externalIdKey] === externalId) ?? null;
        if (found) matchedBy = "external_id";
    }

    if (found) {
        const customer = await followMerge(orm, found);
        // Fill in identifiers the record lacks, and upgrade legacy hashes to the current scheme.
        const updates = {};
        if (emailHash && (!customer.emailHash || (matchedBy === "email" && customer.emailHash !== emailHash && emailHashes.includes(customer.emailHash)))) {
            updates.emailHash = emailHash;
        }
        if (email && !customer.emailEnc) updates.emailEnc = encryptSecret(email);
        if (phoneHash && (!customer.phoneHash || (matchedBy === "phone" && customer.phoneHash !== phoneHash && phoneHashes.includes(customer.phoneHash)))) {
            updates.phoneHash = phoneHash;
        }
        if (externalId) {
            const ext = readExternalIds(customer);
            if (!ext[externalIdKey]) updates.externalIds = { ...ext, [externalIdKey]: externalId };
        }
        if (Object.keys(updates).length) {
            await orm.Customer.where({ id: customer.id, workspaceId }).update(updates);
            Object.assign(customer, updates);
        }
        return { customer, isNew: false, matchedBy };
    }

    if (!create) return { customer: null, isNew: false, matchedBy: null };

    const customer = await orm.Customer.create({
        workspaceId,
        emailHash,
        emailEnc: email ? encryptSecret(email) : null,
        phoneHash,
        externalIds: externalId ? { [externalIdKey]: externalId } : null,
    });
    return { customer, isNew: true, matchedBy: email ? "email" : phone ? "phone" : "external_id" };
}

/** Back-compat wrapper used by older call sites. */
export async function resolveOrCreateCustomer(client, workspaceId, identifiers = {}) {
    const { customer, isNew } = await resolveCustomer(client, workspaceId, identifiers);
    return { customer, isNew };
}

/**
 * Find or create the Visitor row for an SDK visitor id. Visitors may be created by identify/checkout
 * before any touch was recorded (e.g. a direct visitor), so later touches still link up.
 */
export async function ensureVisitor(client, workspaceId, visitorSdkId) {
    if (!visitorSdkId) return null;
    const orm = client.orm.public;
    const existing = await orm.Visitor.where({ workspaceId, visitorId: visitorSdkId }).first();
    if (existing) return existing;
    try {
        return await orm.Visitor.create({ workspaceId, visitorId: visitorSdkId });
    } catch (err) {
        // concurrent create for the same visitor: read the winner
        const again = await orm.Visitor.where({ workspaceId, visitorId: visitorSdkId }).first();
        if (again) return again;
        throw err;
    }
}

/**
 * Link a visitor (device/browser) to a customer. A customer may have many visitors (phone + laptop).
 */
export async function linkVisitorToCustomer(client, workspaceId, visitorSdkId, customerId) {
    if (!visitorSdkId || !customerId) return null;
    const orm = client.orm.public;
    const visitor = await ensureVisitor(client, workspaceId, visitorSdkId);
    if (visitor && visitor.customerId !== customerId) {
        await orm.Visitor.where({ id: visitor.id, workspaceId }).update({ customerId, lastSeenAt: new Date().toISOString() });
        visitor.customerId = customerId;
    }
    return visitor;
}

/** Touches of one SDK visitor id (empty when unknown). */
export async function getVisitorTouches(workspaceId, visitorSdkId, client = db) {
    if (!visitorSdkId) return [];
    const orm = client.orm.public;
    const visitor = await orm.Visitor.where({ workspaceId, visitorId: visitorSdkId }).first();
    if (!visitor) return [];
    return orm.Touch.where({ workspaceId, visitorId: visitor.id }).all();
}

/** Touches of every visitor linked to a customer. */
export async function getCustomerTouches(client, workspaceId, customerId) {
    if (!customerId) return [];
    const orm = client.orm.public;
    const visitors = await orm.Visitor.where({ workspaceId, customerId }).all();
    const out = [];
    for (const v of visitors) out.push(...(await orm.Touch.where({ workspaceId, visitorId: v.id }).all()));
    return out;
}
