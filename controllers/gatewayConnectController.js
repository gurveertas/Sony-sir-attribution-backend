/**
 * One-click payment gateway connection flows.
 * Provider credentials are validated, used to create or verify remote webhooks, then encrypted before storage.
 * Never return stored credentials; one-time setup secrets must be the only sensitive values exposed to the caller.
 */

/**
 * Payment-gateway connect flow — /api/workspace/connectors/{gateways,connect,:id/*}
 *
 *   GET  /connectors/gateways          catalog of supported gateways + form fields (drives the UI)
 *   POST /connectors/connect           one-click connect: creates the connector AND the gateway webhook
 *   GET  /connectors/:id               connector detail (never returns secrets)
 *   POST /connectors/:id/reconnect     new credentials / rotate the signing secret
 *   POST /connectors/:id/disconnect    removes the remote webhook, disables the connector
 *   POST /connectors/:id/verify        health checks (secret stored, remote webhook alive, first event)
 *
 * Stripe and PayPal webhooks are created through their APIs. Razorpay does not allow that for normal
 * merchants, so it returns a generated URL + secret to paste into the Razorpay dashboard (shown once).
 *
 * All endpoints are company_admin only because they handle gateway credentials.
 */

import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { getConnectorConfig, prepareConnectorConfig } from "../utils/connectorConfig.js";
import {
    GATEWAY_CATALOG,
    GATEWAY_TYPES,
    GatewayError,
    ValidationError,
    assertPublicHttpsUrl,
    buildWebhookUrl,
    drivers,
    getPublicApiBase,
    isGatewayType,
} from "../services/gateways/index.js";
import { writeAudit } from "../services/audit.js";

const orm = () => db.orm.public;

const LABELS = { stripe: "Stripe", paypal: "PayPal", razorpay: "Razorpay" };

// ── helpers ──────────────────────────────────────────────────────────────────

/** Public view of a connector. Contains NO secrets (config only holds non-secret fields). */
export function summarizeConnector(c) {
    const cfg = c.config && typeof c.config === "object" ? c.config : {};
    const managed = isGatewayType(c.type) && cfg.gateway === c.type;
    return {
        id: c.id,
        publicId: c.publicId,
        type: c.type,
        name: c.name,
        status: c.status,
        errorCount: c.errorCount,
        lastError: c.lastError ?? null,
        lastEventAt: c.lastEventAt ?? null,
        lastErrorAt: c.lastErrorAt ?? null,
        createdAt: c.createdAt,
        webhookUrl: buildWebhookUrl(c.type, c.id),
        connection: managed
            ? {
                  gateway: cfg.gateway,
                  mode: cfg.connectionMode ?? null,
                  environment: cfg.environment ?? cfg.paypalEnvironment ?? null,
                  accountId: cfg.stripeAccountId ?? null,
                  businessName: cfg.businessName ?? null,
                  enabledEvents: cfg.enabledEvents ?? [],
                  connectedAt: cfg.connectedAt ?? null,
                  reconnectedAt: cfg.reconnectedAt ?? null,
                  disconnectedAt: cfg.disconnectedAt ?? null,
                  awaitingFirstEvent: c.status !== "disabled" && !c.lastEventAt,
              }
            : null,
    };
}

function fail(res, err, extra = {}) {
    if (err instanceof ValidationError) {
        return res.status(400).json({ code: "validation_error", message: err.message });
    }
    if (err instanceof GatewayError) {
        const status =
            err.kind === "invalid_credentials" ? 400 : err.kind === "unavailable" ? 502 : err.kind === "not_found" ? 404 : 422;
        return res.status(status).json({ code: err.kind, provider: err.provider, message: err.message, ...extra });
    }
    // never log request bodies — they contain gateway credentials
    console.error("gatewayConnect error:", err?.message);
    return res.status(500).json({ message: "Internal server error" });
}

async function findOwnGatewayConnector(req, res) {
    const connector = await orm().Connector.where({ id: req.params.id, workspaceId: req.user.workspaceId }).first();
    if (!connector) {
        res.status(404).json({ message: "Connector not found" });
        return null;
    }
    if (!isGatewayType(connector.type)) {
        res.status(400).json({ message: "This operation is only available for Stripe, PayPal and Razorpay connectors" });
        return null;
    }
    return connector;
}

/** Undo a webhook that was created remotely but could not be recorded locally. Never throws. */
async function rollbackRemote(driver, outcome, creds) {
    if (!outcome?.remoteRef?.id) return;
    try {
        await driver.removeRemote({
            config: { ...outcome.publicConfig, ...outcome.secrets },
            creds,
            remoteId: outcome.remoteRef.id,
        });
    } catch (err) {
        console.error("rollbackRemote failed (orphan webhook may remain at the gateway):", err?.message);
    }
}

const safeDeleteConnector = (id) => orm().Connector.where({ id }).delete().catch(() => {});

function audit(tx, req, action, connector, metadata = {}) {
    return writeAudit(tx.orm.public, {
        workspaceId: req.user.workspaceId,
        actorType: "user",
        actorUserId: req.user.id,
        action,
        targetType: "connector",
        targetId: connector.id,
        metadata: { type: connector.type, name: connector.name, ...metadata },
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
    });
}

function readCredentials(driver, body) {
    return driver.parseCredentials(body?.credentials ?? {});
}

// ── GET /connectors/gateways ─────────────────────────────────────────────────

export const listGatewayCatalog = async (_req, res) => {
    let ready = true;
    let problem = null;
    try {
        assertPublicHttpsUrl(getPublicApiBase());
    } catch (err) {
        ready = false;
        problem = err.message;
    }
    return res.status(200).json({ ready, problem, webhookBase: getPublicApiBase(), data: GATEWAY_CATALOG });
};

// ── POST /connectors/connect ─────────────────────────────────────────────────

/**
 * Body: { type: "stripe"|"paypal"|"razorpay", name?: string, credentials: {...} }
 *   stripe:   { secretKey }
 *   paypal:   { clientId, clientSecret, environment: "sandbox"|"live" }
 *   razorpay: {}   (returns a generated secret + URL to paste into the Razorpay dashboard)
 */
export const connectGateway = async (req, res) => {
    const workspaceId = req.user.workspaceId;
    const { type, name } = req.body ?? {};

    if (!isGatewayType(type)) {
        return res.status(400).json({ message: `type must be one of: ${GATEWAY_TYPES.join(", ")}` });
    }
    if (name !== undefined && (typeof name !== "string" || name.trim().length < 1 || name.length > 100)) {
        return res.status(400).json({ message: "name must be a non-empty string up to 100 characters" });
    }

    const driver = drivers[type];
    let creds;
    try {
        creds = readCredentials(driver, req.body);
        assertPublicHttpsUrl(getPublicApiBase());
    } catch (err) {
        return fail(res, err);
    }

    const displayName = (name ?? LABELS[type]).trim();
    let connector;
    try {
        connector = await orm().Connector.create({
            workspaceId,
            type,
            name: displayName,
            publicId: `conn_${crypto.randomBytes(12).toString("hex")}`,
            status: "pending",
        });
    } catch (err) {
        return fail(res, err);
    }

    // 1) create the webhook at the gateway
    const webhookUrl = buildWebhookUrl(type, connector.id);
    let outcome;
    try {
        outcome = await driver.connect({ creds, webhookUrl, connectorId: connector.id, name: displayName });
    } catch (err) {
        await safeDeleteConnector(connector.id);
        return fail(res, err);
    }

    // 2) refuse duplicates of the same gateway account in this workspace
    try {
        if (outcome.fingerprint) {
            const siblings = await orm().Connector.where({ workspaceId, type }).all();
            const duplicate = siblings.find(
                (c) => c.id !== connector.id && c.status !== "disabled" && c.config?.fingerprint === outcome.fingerprint,
            );
            if (duplicate) {
                await rollbackRemote(driver, outcome, creds);
                await safeDeleteConnector(connector.id);
                return res.status(409).json({
                    code: "already_connected",
                    message: `This ${LABELS[type]} account is already connected (“${duplicate.name}”). Use reconnect on that connector instead.`,
                    connectorId: duplicate.id,
                });
            }
        }

        // 3) persist: non-secret config in `config`, secrets encrypted in `secretsEnc`
        const stored = prepareConnectorConfig({
            ...outcome.publicConfig,
            fingerprint: outcome.fingerprint,
            connectedAt: new Date().toISOString(),
            ...outcome.secrets,
        });
        await db.transaction(async (tx) => {
            await tx.orm.public.Connector.where({ id: connector.id }).update({ ...stored, status: "pending" });
            await audit(tx, req, "connector.connected", connector, {
                mode: driver.mode,
                remoteWebhookId: outcome.remoteRef?.id ?? null,
                environment: outcome.publicConfig.environment ?? outcome.publicConfig.paypalEnvironment ?? null,
            });
        });
    } catch (err) {
        await rollbackRemote(driver, outcome, creds);
        await safeDeleteConnector(connector.id);
        return fail(res, err);
    }

    const saved = await orm().Connector.where({ id: connector.id }).first();
    return res.status(201).json({
        ...summarizeConnector(saved),
        connected: true,
        mode: driver.mode,
        message:
            driver.mode === "auto"
                ? `${LABELS[type]} is connected and the webhook has been created. The connector turns healthy when the first event arrives.`
                : `Connector created. Finish setup by adding the webhook in your ${LABELS[type]} dashboard (details in "setup").`,
        // Razorpay only: the signing secret is returned exactly once and cannot be retrieved later.
        setup: outcome.reveal,
    });
};

// ── GET /connectors/:id ──────────────────────────────────────────────────────

export const getConnector = async (req, res) => {
    try {
        const connector = await orm().Connector.where({ id: req.params.id, workspaceId: req.user.workspaceId }).first();
        if (!connector) return res.status(404).json({ message: "Connector not found" });

        const driver = drivers[connector.type];
        return res.status(200).json({
            ...summarizeConnector(connector),
            mode: driver?.mode ?? "manual",
            requiredEvents: driver?.events ?? [],
            hasSigningSecret: Boolean(connector.secretsEnc && connector.secretsEnc.length),
        });
    } catch (err) {
        return fail(res, err);
    }
};

// ── POST /connectors/:id/reconnect ───────────────────────────────────────────

/**
 * Re-creates the webhook with new credentials (Stripe/PayPal) or rotates the signing secret (Razorpay).
 * Also the way to re-enable a disconnected connector.
 */
export const reconnectConnector = async (req, res) => {
    try {
        const connector = await findOwnGatewayConnector(req, res);
        if (!connector) return;

        const driver = drivers[connector.type];
        const creds = readCredentials(driver, req.body);
        assertPublicHttpsUrl(getPublicApiBase());

        const previous = getConnectorConfig(connector);
        const webhookUrl = buildWebhookUrl(connector.type, connector.id);
        const outcome = await driver.connect({
            creds,
            webhookUrl,
            connectorId: connector.id,
            name: connector.name,
            attempt: crypto.randomBytes(4).toString("hex"),
        });

        try {
            const now = new Date().toISOString();
            const stored = prepareConnectorConfig({
                ...outcome.publicConfig,
                fingerprint: outcome.fingerprint,
                connectedAt: previous.connectedAt ?? now,
                reconnectedAt: now,
                ...outcome.secrets,
            });
            await db.transaction(async (tx) => {
                await tx.orm.public.Connector.where({ id: connector.id }).update({
                    ...stored,
                    status: "pending",
                    lastError: null,
                });
                await audit(tx, req, "connector.reconnected", connector, {
                    remoteWebhookId: outcome.remoteRef?.id ?? null,
                });
            });
        } catch (err) {
            // the old webhook (if any) is still intact; only drop the new one if it is a different object
            if (outcome.remoteRef?.id && outcome.remoteRef.id !== (previous.webhookEndpointId ?? previous.webhookId)) {
                await rollbackRemote(driver, outcome, creds);
            }
            throw err;
        }

        // best effort: remove the previous remote webhook so the gateway does not keep sending to a dead secret
        const oldRemoteId = previous.webhookEndpointId ?? previous.webhookId;
        let previousRemoved = null;
        if (oldRemoteId && oldRemoteId !== outcome.remoteRef?.id) {
            try {
                const removal = await driver.removeRemote({ config: previous, creds, remoteId: oldRemoteId });
                previousRemoved = removal.removed || removal.reason === "already_removed";
            } catch {
                previousRemoved = false;
            }
        }

        const saved = await orm().Connector.where({ id: connector.id }).first();
        return res.status(200).json({
            ...summarizeConnector(saved),
            connected: true,
            mode: driver.mode,
            previousWebhookRemoved: previousRemoved,
            setup: outcome.reveal,
        });
    } catch (err) {
        return fail(res, err);
    }
};

// ── POST /connectors/:id/disconnect ──────────────────────────────────────────

/**
 * Body: { credentials?: { secretKey } (Stripe only — to delete the remote endpoint), force?: boolean }
 *
 * The connector is DISABLED (not deleted) so its orders, events and audit history stay intact.
 * Stored secrets are wiped and further events are acknowledged and ignored.
 */
export const disconnectConnector = async (req, res) => {
    try {
        const connector = await findOwnGatewayConnector(req, res);
        if (!connector) return;

        if (connector.status === "disabled") {
            return res.status(200).json({ ...summarizeConnector(connector), alreadyDisconnected: true });
        }

        const driver = drivers[connector.type];
        const force = req.body?.force === true;
        const existing = getConnectorConfig(connector);

        let creds = null;
        if (req.body?.credentials && connector.type === "stripe") creds = readCredentials(driver, req.body);

        let remote;
        try {
            remote = await driver.removeRemote({ config: existing, creds });
        } catch (err) {
            if (!force) {
                return fail(res, err, {
                    canForce: true,
                    hint: "Retry, or send force=true to disconnect anyway and delete the webhook manually in the gateway dashboard.",
                });
            }
            remote = { removed: false, reason: "remote_error" };
        }

        const publicConfig = { ...(connector.config ?? {}) };
        delete publicConfig.webhookEndpointId;
        delete publicConfig.webhookId;
        publicConfig.disconnectedAt = new Date().toISOString();

        await db.transaction(async (tx) => {
            await tx.orm.public.Connector.where({ id: connector.id }).update({
                status: "disabled",
                config: publicConfig,
                secretsEnc: null,
            });
            await audit(tx, req, "connector.disconnected", connector, {
                remoteRemoved: remote.removed,
                remoteReason: remote.reason ?? null,
                forced: force,
            });
        });

        const saved = await orm().Connector.where({ id: connector.id }).first();
        const needsManualCleanup = !remote.removed && remote.reason !== "already_removed" && remote.reason !== "no_remote_webhook";
        return res.status(200).json({
            ...summarizeConnector(saved),
            remoteWebhook: { removed: remote.removed, reason: remote.reason ?? null },
            manualSteps: needsManualCleanup
                ? [`Delete the webhook for ${buildWebhookUrl(connector.type, connector.id)} in your ${LABELS[connector.type]} dashboard so it stops sending events.`]
                : [],
        });
    } catch (err) {
        return fail(res, err);
    }
};

// ── POST /connectors/:id/verify ──────────────────────────────────────────────

/** Body (optional, Stripe only): { credentials: { secretKey } } to also check the remote endpoint. */
export const verifyConnector = async (req, res) => {
    try {
        const connector = await findOwnGatewayConnector(req, res);
        if (!connector) return;

        const driver = drivers[connector.type];
        const config = getConnectorConfig(connector);
        const creds = req.body?.credentials && connector.type === "stripe" ? readCredentials(driver, req.body) : null;

        let checks;
        try {
            checks = await driver.verify({
                connector,
                config,
                creds,
                webhookUrl: buildWebhookUrl(connector.type, connector.id),
            });
        } catch (err) {
            if (!(err instanceof GatewayError)) throw err;
            checks = [{ name: "gateway_reachable", ok: false, detail: err.message }];
        }

        const blocking = checks.filter((c) => c.name !== "first_event_received");
        return res.status(200).json({
            status: connector.status,
            lastEventAt: connector.lastEventAt ?? null,
            errorCount: connector.errorCount,
            lastError: connector.lastError ?? null,
            ok: blocking.every((c) => c.ok) && connector.status !== "disabled",
            awaitingFirstEvent: !connector.lastEventAt,
            checks,
        });
    } catch (err) {
        return fail(res, err);
    }
};
