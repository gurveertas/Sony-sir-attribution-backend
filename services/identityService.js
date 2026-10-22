/**
 * Identity Resolution Service
 *
 * Resolves or creates a Customer from:
 *   1. hashed email
 *   2. hashed phone
 *   3. external ID (system-specific, e.g. Zenoti guest ID)
 *
 * Also links Visitor records to the resolved Customer.
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { encryptSecret } from "../utils/crypto.js";

export const hashIdentifier = (value) =>
    crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");

/**
 * Resolves a customer using email hash, phone hash, or external IDs.
 * If no match: creates a new customer.
 * If a match is found: returns existing customer.
 * Call inside a transaction when combined with order/booking creation.
 *
 * @param {object} client - db or transaction client
 * @param {string} workspaceId
 * @param {object} identifiers - { email?, phone?, externalId?, externalIdKey? }
 * @returns {Promise<{ customer, isNew }>}
 */
export async function resolveOrCreateCustomer(client, workspaceId, identifiers = {}) {
    const orm = client.orm.public;
    const { email, phone, externalId, externalIdKey = "default" } = identifiers;

    const emailHash = email ? hashIdentifier(email) : null;
    const phoneHash = phone ? hashIdentifier(phone) : null;

    // Try email hash first
    if (emailHash) {
        const existing = await orm.Customer.where({ workspaceId, emailHash }).first();
        if (existing) {
            if (email && !existing.emailEnc) {
                await orm.Customer.where({ id: existing.id }).update({
                    emailEnc: encryptSecret(String(email).trim().toLowerCase()),
                });
            }
            return { customer: existing, isNew: false };
        }
    }

    // Try phone hash second
    if (phoneHash) {
        const existing = await orm.Customer.where({ workspaceId, phoneHash }).first();
        if (existing) {
            // Optionally attach email hash to existing record if not already set
            const updates = {};
            if (emailHash && !existing.emailHash) updates.emailHash = emailHash;
            if (email && !existing.emailEnc) {
                updates.emailEnc = encryptSecret(String(email).trim().toLowerCase());
            }
            if (Object.keys(updates).length > 0) {
                await orm.Customer.where({ id: existing.id }).update(updates);
            }
            return { customer: existing, isNew: false };
        }
    }

    // Try external ID
    if (externalId && externalIdKey) {
        const allCustomers = await orm.Customer.where({ workspaceId }).all();
        const matched = allCustomers.find(c => {
            if (!c.externalIds) return false;
            try {
                const ext = typeof c.externalIds === "string" ? JSON.parse(c.externalIds) : c.externalIds;
                return ext[externalIdKey] === externalId;
            } catch {
                return false;
            }
        });
        if (matched) {
            const updates = {};
            if (emailHash && !matched.emailHash) updates.emailHash = emailHash;
            if (email && !matched.emailEnc) {
                updates.emailEnc = encryptSecret(String(email).trim().toLowerCase());
            }
            if (phoneHash && !matched.phoneHash) updates.phoneHash = phoneHash;
            if (Object.keys(updates).length > 0) {
                await orm.Customer.where({ id: matched.id }).update(updates);
            }
            return { customer: matched, isNew: false };
        }
    }

    // Create new customer
    const newCustomer = await orm.Customer.create({
        workspaceId,
        emailHash: emailHash ?? null,
        emailEnc: email ? encryptSecret(String(email).trim().toLowerCase()) : null,
        phoneHash: phoneHash ?? null,
        externalIds: externalId ? { [externalIdKey]: externalId } : null,
    });

    return { customer: newCustomer, isNew: true };
}

/**
 * Links a visitor (by SDK visitor ID) to a customer.
 * Upserts the Visitor record and sets customerId.
 *
 * @param {object} client - db or transaction client
 * @param {string} workspaceId
 * @param {string} visitorSdkId - the client-side visitor ID
 * @param {string} customerId
 */
export async function linkVisitorToCustomer(client, workspaceId, visitorSdkId, customerId) {
    if (!visitorSdkId) return;
    const orm = client.orm.public;
    const existing = await orm.Visitor.where({ workspaceId, visitorId: visitorSdkId }).first();
    if (existing) {
        if (existing.customerId !== customerId) {
            await orm.Visitor.where({ id: existing.id }).update({ customerId, lastSeenAt: new Date().toISOString() });
        }
    }
}

/**
 * Looks up a Visitor by SDK visitor ID and returns their touches.
 * Used for matching when a checkout token is not available.
 */
export async function getVisitorTouches(workspaceId, visitorSdkId) {
    if (!visitorSdkId) return [];
    const orm = db.orm.public;
    const visitor = await orm.Visitor.where({ workspaceId, visitorId: visitorSdkId }).first();
    if (!visitor) return [];
    return orm.Touch.where({ visitorId: visitor.id }).all();
}
