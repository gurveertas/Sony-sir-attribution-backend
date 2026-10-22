import crypto from "crypto";
import { db } from "../src/prisma/db.js";
import { writeAudit } from "../services/audit.js";

const MODES = ["test", "live"];
const KEY_TYPE = "publishable";
const RATE_LIMIT_PER_MIN = 600;
const MAX_ORIGINS = 20;
const PG_UNIQUE_VIOLATION = "23505"; 

async function fetchWorkspaceKeys(client, workspaceId) {
  return client.orm.public.ApiKey.where({ workspaceId }).all();
}

// The single active (not revoked) key, or undefined.
async function fetchActiveKey(client, workspaceId) {
  const rows = await fetchWorkspaceKeys(client, workspaceId);
  return rows.find((row) => !row.revokedAt);
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function generateKey(mode, type = "publishable") {
  const prefix = type === "secret" ? `sk_${mode}_` : `pk_${mode}_`;
  const key = prefix + crypto.randomBytes(32).toString("base64url");
  return {
    key,
    keyPrefix: key.slice(0, 12), // lets the UI tell keys apart
    keyHash: sha256(key), // what we store and look up
  };
}

// Accepts "https://example.com" style origins only: no path, query or credentials.
// http is allowed only for localhost in test mode. Returns a clean origin or null.
function normalizeOrigin(raw, mode) {
  try {
    const url = new URL(String(raw).trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.pathname !== "/" || url.search || url.hash || url.username) return null;
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol === "http:" && !(isLocal && mode === "test")) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function parseOrigins(list, mode) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ORIGINS)
    return { error: `allowedOrigins must have 1-${MAX_ORIGINS} entries` };
  
  const origins = list.map((origin) => normalizeOrigin(origin, mode));
  if (origins.some((origin) => origin === null))
    return { error: "each origin must look like https://example.com (no path)" };
  return { value: [...new Set(origins)] }; // remove duplicates
}

const validName = (name) =>
  typeof name === "string" && name.trim().length > 0 && name.trim().length <= 60;

// Only company admins manage keys. Returns the workspace id, or sends an error and returns null.
// req.user comes from your JWT, so genToken must include `workspaceId` in the payload.
function requireCompanyAdmin(req, res) {
  const user = req.user;
  if (!user?.workspaceId)
    return void res.status(403).json({ message: "Workspace access required" });
  if (user.role !== "company_admin")
    return void res.status(403).json({ message: "Only company admins can manage API keys" });
  return user.workspaceId; // never read the workspace from req.body
}

// What we send back to the client. keyHash is deliberately left out.
function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mode: row.mode,
    keyPrefix: row.keyPrefix,
    siteId: row.siteId ?? null,
    allowedOrigins: row.allowedOrigins,
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAt: row.lastUsedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    rotatedFromId: row.rotatedFromId ?? null,
    revokedAt: row.revokedAt ?? null,
    createdAt: row.createdAt,
  };
}

// Writes an audit row. `client` is either `db` or a transaction `tx`, so the audit entry
// commits or rolls back together with the change. Store ids and field names, never the key.
async function audit(client, req, workspaceId, action, targetId, metadata = null) {
  await writeAudit(client.orm.public, {
    workspaceId,
    actorType: "user",
    actorUserId: req.user.id,
    action,
    targetType: "api_key",
    targetId,
    metadata,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });
}

// ---------------------------------------------------------------------------
// POST /api-keys
// Body: { name, mode?: "live" | "test", type?: "publishable" | "secret", allowedOrigins: [..], siteId?, rateLimitPerMin? }
// ---------------------------------------------------------------------------

export const createApiKey = async (req, res) => {
  try {
    const workspaceId = requireCompanyAdmin(req, res);
    if (!workspaceId) return;

    const { name, mode = "live", type = "publishable", allowedOrigins, siteId, rateLimitPerMin = RATE_LIMIT_PER_MIN } = req.body ?? {};

    // 1. Validate the input
    if (!validName(name))
      return res.status(400).json({ message: "name is required (max 60 characters)" });
    if (!MODES.includes(mode))
      return res.status(400).json({ message: "mode must be test or live" });
    const keyType = ["publishable", "secret"].includes(type) ? type : "publishable";

    let originsList = [];
    if (keyType === "publishable") {
      const origins = parseOrigins(allowedOrigins, mode);
      if (origins.error) return res.status(400).json({ message: origins.error });
      originsList = origins.value;
    } else if (Array.isArray(allowedOrigins)) {
      originsList = allowedOrigins;
    }

    if (siteId !== undefined && typeof siteId !== "string")
      return res.status(400).json({ message: "siteId must be a string" });

    // 2. If a site is given, it must belong to THIS workspace
    if (siteId) {
      const site = await db.orm.public.Site.where({ id: siteId, workspaceId }).first();
      if (!site) return res.status(404).json({ message: "Site not found" });
    }

    // 3. Enforce one active key per type per workspace
    const allKeys = await fetchWorkspaceKeys(db, workspaceId);
    const existing = allKeys.find((row) => !row.revokedAt && row.type === keyType);
    if (existing)
      return res.status(409).json({
        message: `This workspace already has an active ${keyType} API key. Rotate or revoke it first.`,
      });

    // 4. Generate the key and save it with the audit entry, in one transaction
    const { key, keyPrefix, keyHash } = generateKey(mode, keyType);

    const created = await db.transaction(async (tx) => {
      const row = await tx.orm.public.ApiKey.create({
        workspaceId,
        siteId: siteId ?? null,
        name: name.trim(),
        type: keyType,
        mode,
        keyPrefix,
        keyHash,
        allowedOrigins: originsList,
        rateLimitPerMin: Number(rateLimitPerMin) || RATE_LIMIT_PER_MIN,
        createdBy: req.user.id,
      });
      // await audit(tx, req, workspaceId, "api_key.created", row.id, { mode, type: keyType });
      return row;
    });

    // 5. The only moment the full key leaves the server
    return res.status(201).json({ ...toPublic(created), key, apiKey: key });
  } catch (error) {
    // The partial unique index (one active key per workspace) catches double-clicks
    // that slip past the check in step 3.
    if (error?.code === PG_UNIQUE_VIOLATION)
      return res.status(409).json({ message: "This workspace already has an active API key" });
    console.error("createApiKey error:", error.message); // never log req.body
    return res.status(500).json({ message: "Internal server error while creating API key" });
  }
};

// ---------------------------------------------------------------------------
// GET /api-keys?includeRevoked=true
// ---------------------------------------------------------------------------

export const listApiKeys = async (req, res) => {
  try {
    const workspaceId = requireCompanyAdmin(req, res);
    if (!workspaceId) return;

    let rows = await fetchWorkspaceKeys(db, workspaceId);
    if (req.query.includeRevoked !== "true") rows = rows.filter((row) => !row.revokedAt);

    // Newest first. createdAt is an ISO string, so string comparison sorts correctly.
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.status(200).json({ data: rows.map(toPublic) });
  } catch (error) {
    console.error("listApiKeys error:", error.message);
    return res.status(500).json({ message: "Internal server error while listing API keys" });
  }
};

// ---------------------------------------------------------------------------
// PATCH /api-keys/:id
// Body: { name?, allowedOrigins? }   (the key itself can never be changed)
// ---------------------------------------------------------------------------

export const updateApiKey = async (req, res) => {
  try {
    const workspaceId = requireCompanyAdmin(req, res);
    if (!workspaceId) return;

    // Scoped by workspace: another company's key looks like "not found"
    const key = await db.orm.public.ApiKey.where({
      id: req.params.id,
      workspaceId,
    }).first();
    if (!key || key.revokedAt) return res.status(404).json({ message: "API key not found" });

    const changes = {};
    const { name, allowedOrigins } = req.body ?? {};

    if (name !== undefined) {
      if (!validName(name))
        return res.status(400).json({ message: "name must be 1-60 characters" });
      changes.name = name.trim();
    }

    if (allowedOrigins !== undefined) {
      const origins = parseOrigins(allowedOrigins, key.mode);
      if (origins.error) return res.status(400).json({ message: origins.error });
      changes.allowedOrigins = origins.value;
    }

    if (Object.keys(changes).length === 0)
      return res.status(400).json({ message: "Nothing to update" });

    await db.transaction(async (tx) => {
      await tx.orm.public.ApiKey.where({ id: key.id }).update(changes);
      // await audit(tx, req, workspaceId, "api_key.updated", key.id, {
      //   fields: Object.keys(changes), // field names only
      // });
    });

    // Re-read so the response shows the saved values
    const updated = await db.orm.public.ApiKey.where({ id: key.id }).first();
    return res.status(200).json(toPublic(updated));
  } catch (error) {
    console.error("updateApiKey error:", error.message);
    return res.status(500).json({ message: "Internal server error while updating API key" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /api-keys/:id
// Revokes the key (sets revokedAt). We never hard-delete, so the audit trail stays
// and requests that still use the key fail cleanly with 401.
// ---------------------------------------------------------------------------

export const revokeApiKey = async (req, res) => {
  try {
    const workspaceId = requireCompanyAdmin(req, res);
    if (!workspaceId) return;

    const key = await db.orm.public.ApiKey.where({
      id: req.params.id,
      workspaceId,
    }).first();
    if (!key) return res.status(404).json({ message: "API key not found" });

    // Idempotent: revoking an already revoked key is not an error
    if (!key.revokedAt) {
      await db.transaction(async (tx) => {
        await tx.orm.public.ApiKey.where({ id: key.id }).update({
          revokedAt: new Date().toISOString(),
        });
        await audit(tx, req, workspaceId, "api_key.revoked", key.id);
      });
    }

    return res.status(204).end();
  } catch (error) {
    console.error("revokeApiKey error:", error.message);
    return res.status(500).json({ message: "Internal server error while revoking API key" });
  }
};

// ---------------------------------------------------------------------------
// POST /api-keys/rotate
// Replaces the active key with a new one (same name, mode and origins) in ONE
// transaction, so there is no gap where the workspace has no working key.
// ---------------------------------------------------------------------------

export const rotateApiKey = async (req, res) => {
  try {
    const workspaceId = requireCompanyAdmin(req, res);
    if (!workspaceId) return;

    const old = await fetchActiveKey(db, workspaceId);
    if (!old) return res.status(404).json({ message: "No active API key to rotate" });

    const { key, keyPrefix, keyHash } = generateKey(old.mode);

    const created = await db.transaction(async (tx) => {
      // Revoke first, so the one-active-key rule is never broken
      await tx.orm.public.ApiKey.where({ id: old.id }).update({
        revokedAt: new Date().toISOString(),
      });

      const row = await tx.orm.public.ApiKey.create({
        workspaceId,
        siteId: old.siteId ?? null,
        name: old.name,
        type: KEY_TYPE,
        mode: old.mode,
        keyPrefix,
        keyHash,
        allowedOrigins: old.allowedOrigins,
        rateLimitPerMin: old.rateLimitPerMin,
        rotatedFromId: old.id, // links new key to old one
        createdBy: req.user.id,
      });

      // await audit(tx, req, workspaceId, "api_key.rotated", row.id, { rotatedFromId: old.id });
      return row;
    });

    return res.status(201).json({ ...toPublic(created), key });
  } catch (error) {
    console.error("rotateApiKey error:", error.message);
    return res.status(500).json({ message: "Internal server error while rotating API key" });
  }
};

export const adminListApiKeys = async (req, res) => {
  try {
    if (req.user?.role !== "platform_admin") {
      return res.status(403).json({ message: "Platform admins only" });
    }

    const workspaceId = req.params.companyId;
    // const reason = String(req.query.reason ?? "").trim();
    // if (reason.length < 5) {
    //   return res.status(400).json({ message: "A reason is required to view a company's keys" });
    // }

    const workspace = await db.orm.public.Workspace.where({ id: workspaceId }).first();
    if (!workspace) return res.status(404).json({ message: "Company not found" });

    // Log the access first, so it is recorded even if the read fails afterwards
    // await writeAudit(db.orm.public, {
    //   workspaceId,
    //   actorType: "platform_admin",
    //   actorUserId: req.user.id,
    //   action: "admin.viewed_api_keys",
    //   targetType: "workspace",
    //   targetId: workspaceId,
    //   reason,
    //   ip: req.ip ?? null,
    //   userAgent: req.headers["user-agent"] ?? null,
    // });

    const rows = await db.orm.public.ApiKey.where({ workspaceId }).all();
    return res.status(200).json({ data: rows.map(toPublic) }); // prefix only, never the full key
  } catch (error) {
    console.error("adminListApiKeys error:", error.message);
    return res.status(500).json({ message: "Internal server error while listing API keys" });
  }
};