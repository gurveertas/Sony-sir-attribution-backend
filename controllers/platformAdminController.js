
import { db } from "../src/prisma/db.js";
import { writeAudit } from "../services/audit.js";
import { validateWorkspaceSettings, scheduleRebuildIfNeeded } from "../services/workspaceSettings.js";
import { workspaceStats } from "./platformToolsController.js";

const orm = (client = db) => client.orm.public;
const ADMIN_ROLE = "platform_admin";

const WORKSPACE_STATUSES = new Set([
  "pending",
  "active",
  "suspended",
  "closed",
]);

const now = () => new Date().toISOString();

const reasonFrom = (req) =>
  String(req.body?.reason ?? req.query?.reason ?? "").trim();

function requirePlatformAdmin(req, res) {
  if (req.user?.role !== ADMIN_ROLE) {
    res.status(403).json({ message: "Platform admins only" });
    return false;
  }

  return true;
}

function validId(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 200
  );
}

function pageParams(req) {
  const page = Math.max(
    1,
    Number.parseInt(req.query.page, 10) || 1
  );

  const limit = Math.min(
    100,
    Math.max(1, Number.parseInt(req.query.limit, 10) || 25)
  );

  return { page, limit };
}

function pageRows(rows, req) {
  const { page, limit } = pageParams(req);

  return {
    data: rows.slice((page - 1) * limit, page * limit),
    pagination: {
      page,
      limit,
      total: rows.length,
      pages: Math.ceil(rows.length / limit),
    },
  };
}

async function audit(
  req,
  action,
  {
    workspaceId = null,
    targetType = null,
    targetId = null,
    reason = null,
    metadata = null,
  } = {}
) {
  await writeAudit(orm(), {
    workspaceId,
    actorType: "platform_admin",
    actorUserId: req.user.id,
    action,
    targetType,
    targetId,
    reason,
    metadata,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });
}

async function requireReason(req, res) {
  const reason = reasonFrom(req);

  if (reason.length < 5) {
    res.status(400).json({
      message: "Provide a reason of at least 5 characters.",
    });
    return null;
  }

  return reason;
}

async function getWorkspaceOr404(id, res) {
  if (!validId(id)) {
    res.status(400).json({
      message: "A valid workspace id is required.",
    });
    return null;
  }

  const workspace = await orm().Workspace.where({ id }).first();

  if (!workspace) {
    res.status(404).json({ message: "Workspace not found." });
    return null;
  }

  return workspace;
}

// GET /api/platform-admin/dashboard
export const getPlatformDashboard = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    const [workspaces, users, keys, connectors, webhooks] =
      await Promise.all([
        orm().Workspace.all(),
        orm().User.all(),
        orm().ApiKey.all(),
        orm().Connector.all(),
        orm().WebhookEndpoint.all(),
        // orm().AuditLog.all(),
      ]);

    return res.json({
      data: {
        workspaces: {
          total: workspaces.length,
          unverified: workspaces.filter(
            (x) => Boolean(x.emailVerificationHash)
          ).length,
          active: workspaces.filter(
            (x) => x.status === "active"
          ).length,
          suspended: workspaces.filter(
            (x) => x.status === "suspended"
          ).length,
          closed: workspaces.filter(
            (x) => x.status === "closed"
          ).length,
        },

        users: {
          total: users.length,
          platformAdmins: users.filter(
            (x) =>
              x.role === ADMIN_ROLE &&
              x.status === "active"
          ).length,
          active: users.filter(
            (x) => x.status === "active"
          ).length,
          deactivated: users.filter(
            (x) => x.status === "deactivated"
          ).length,
        },

        apiKeys: {
          total: keys.length,
          active: keys.filter(
            (x) =>
              !x.revokedAt &&
              (!x.expiresAt ||
                new Date(x.expiresAt) > new Date())
          ).length,
          revoked: keys.filter((x) => !!x.revokedAt).length,
        },

        connectors: {
          total: connectors.length,
          healthy: connectors.filter(
            (x) => x.status === "healthy"
          ).length,
          failing: connectors.filter(
            (x) => x.status === "failing"
          ).length,
          disabled: connectors.filter(
            (x) => x.status === "disabled"
          ).length,
        },

        webhooks: {
          total: webhooks.length,
          active: webhooks.filter((x) => x.isActive).length,
        },

        // auditEvents: logs.length,
      },
    })
  } catch (error) {
    console.error("getPlatformDashboard:", error.message);

    return res.status(500).json({
      message: "Could not load platform dashboard.",
    });
  }
};

// GET /api/platform-admin/workspaces
export const listWorkspaces = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    // await audit(req, "admin.workspace_listed", {
    //   reason,
    //   targetType: "workspace",
    //   metadata: {
    //     status: req.query.status ?? null,
    //     search: req.query.search ?? null,
    //   },
    // });

    let rows = await orm().Workspace.all();

    if (req.query.status) {
      rows = rows.filter(
        (x) => x.status === req.query.status
      );
    }

    if (req.query.search) {
      const query = String(req.query.search).toLowerCase();

      rows = rows.filter((x) =>
        [x.name, x.slug, x.id, x.websiteUrl, x.industry]
          .some((value) =>
            String(value ?? "").toLowerCase().includes(query)
          )
      );
    }

    rows.sort((a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt))
    );

    // company list (4.9): status, plan, country, events per day, last event time, integration health
    const page = pageRows(rows, req);
    const stats = await workspaceStats(page.data.map((w) => w.id));
    page.data = page.data.map(({ emailVerificationHash, ...w }) => ({
      ...w,
      emailVerified: !emailVerificationHash,
      ...(stats.get(w.id) ?? {}),
    }));
    return res.json(page);
  } catch (error) {
    console.error("listWorkspaces:", error.message);

    return res.status(500).json({
      message: "Could not list workspaces.",
    });
  }
};

// GET /api/platform-admin/workspaces/:workspaceId
export const getWorkspaceDetails = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const workspace = await getWorkspaceOr404(
      req.params.workspaceId,
      res
    );

    if (!workspace) return;

    // await audit(req, "admin.workspace_viewed", {
    //   workspaceId: workspace.id,
    //   targetType: "workspace",
    //   targetId: workspace.id,
    //   reason,
    // });

    const [users, sites, locations, keys, connectors, webhooks] =
      await Promise.all([
        orm().User.where({ workspaceId: workspace.id }).all(),
        orm().Site.where({ workspaceId: workspace.id }).all(),
        orm().Location.where({ workspaceId: workspace.id }).all(),
        orm().ApiKey.where({ workspaceId: workspace.id }).all(),
        orm().Connector.where({ workspaceId: workspace.id }).all(),
        orm().WebhookEndpoint.where({
          workspaceId: workspace.id,
        }).all(),
      ]);

    const {
      emailVerificationHash,
      ...safeWorkspace
    } = workspace;

    return res.json({
      data: {
        workspace: safeWorkspace,

        users: users.map(
          ({ passwordHash, ...user }) => user
        ),

        sites: sites.map(
          ({ verificationToken, ...site }) => site
        ),

        locations,

        apiKeys: keys.map((key) => ({
          id: key.id,
          workspaceId: key.workspaceId,
          siteId: key.siteId ?? null,
          name: key.name,
          type: key.type,
          mode: key.mode,
          keyPrefix: key.keyPrefix,
          allowedOrigins: key.allowedOrigins,
          rateLimitPerMin: key.rateLimitPerMin,
          lastUsedAt: key.lastUsedAt ?? null,
          expiresAt: key.expiresAt ?? null,
          revokedAt: key.revokedAt ?? null,
          createdAt: key.createdAt,
        })),

        connectors: connectors.map((connector) => ({
          id: connector.id,
          workspaceId: connector.workspaceId,
          type: connector.type,
          name: connector.name,
          publicId: connector.publicId,
          status: connector.status,
          errorCount: connector.errorCount,
          lastError: connector.lastError ?? null,
          createdAt: connector.createdAt,
        })),

        webhooks: webhooks.map((webhook) => ({
          id: webhook.id,
          workspaceId: webhook.workspaceId,
          url: webhook.url,
          eventTypes: webhook.eventTypes,
          isActive: webhook.isActive,
          consecutiveFailures: webhook.consecutiveFailures,
          createdAt: webhook.createdAt,
        })),
      },
    });
  } catch (error) {
    console.error("getWorkspaceDetails:", error.message);

    return res.status(500).json({
      message: "Could not load workspace details.",
    });
  }
};

// PATCH /api/platform-admin/workspaces/:workspaceId/status
export const setWorkspaceStatus = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    const { status } = req.body ?? {};
    if (!WORKSPACE_STATUSES.has(status)) {
      return res.status(400).json({ message: "Invalid workspace status." });
    }

    const workspace = await getWorkspaceOr404(req.params.workspaceId, res);
    if (!workspace) return;

    // Suspending or closing a company is always explained (it is shown to the company in its audit log).
    const reason = String(req.body?.suspendedReason ?? req.body?.reason ?? "").trim();
    if ((status === "suspended" || status === "closed") && reason.length < 5) {
      return res.status(400).json({ message: "Provide a reason of at least 5 characters." });
    }

    const changes = {
      status,
      suspendedReason: status === "suspended" || status === "closed" ? reason.slice(0, 1000) : null,
    };
    // Approval (pending -> active) and reactivation record who approved it the first time.
    if (status === "active" && !workspace.approvedAt) {
      changes.approvedAt = now();
      changes.approvedBy = req.user.id;
    }

    // Users are NOT deactivated: protectRoute / apiKeyAuth already refuse every request of a
    // non-active company, and reactivating must restore access exactly as it was.
    await orm().Workspace.where({ id: workspace.id }).update(changes);
    await audit(req, `admin.workspace_${status === "active" && workspace.status === "pending" ? "approved" : `status_${status}`}`, {
      workspaceId: workspace.id,
      targetType: "workspace",
      targetId: workspace.id,
      reason: reason || null,
      metadata: { previousStatus: workspace.status, newStatus: status },
    });

    const updated = await orm().Workspace.where({ id: workspace.id }).first();
    const { emailVerificationHash: _h, ...safe } = updated ?? {};
    return res.json({ message: `Workspace status set to ${status}.`, data: safe });
  } catch (error) {
    console.error("setWorkspaceStatus:", error.message);
    return res.status(500).json({ message: "Could not update workspace status." });
  }
};

const ALLOWED_WORKSPACE_SETTINGS = new Set([
  "name",
  "country",
  "dataRegion",
  "industry",
  "websiteUrl",
  "reportingCurrency",
  "fxRateMode",
  "weekStart",
  "defaultModel",
  "lookbackDays",
  "lookbackOverrides",
  "consentMode",
  "rawRetentionMonths",
  "plan",
  "timezone",
  "taxIncludedInRevenue",
]);

// PATCH /workspaces/:workspaceId/settings
export const updateWorkspaceSettings = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const workspace = await getWorkspaceOr404(
      req.params.workspaceId, res
    );
    if (!workspace) return;

    const changes = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([key]) =>
        ALLOWED_WORKSPACE_SETTINGS.has(key)
      )
    );

    delete changes.id;
    delete changes.slug;
    delete changes.status; // status changes go through PATCH /status (reason + audit)
    delete changes.approvedAt;
    delete changes.approvedBy;

    if (!Object.keys(changes).length) {
      return res.status(400).json({
        message: "No supported settings provided.",
      });
    }

    const problem = validateWorkspaceSettings(changes);
    if (problem) return res.status(400).json({ message: problem });

    await orm().Workspace.where({ id: workspace.id }).update(changes);
    await audit(req, "admin.workspace_settings_updated", {
      workspaceId: workspace.id,
      targetType: "workspace",
      targetId: workspace.id,
      reason: reasonFrom(req) || null,
      metadata: { changedFields: Object.keys(changes) },
    });
    await scheduleRebuildIfNeeded(workspace.id, Object.keys(changes), req.user.id);

    const updated = await orm().Workspace.where({ id: workspace.id }).first();
    const { emailVerificationHash: _h, ...safe } = updated ?? {};
    return res.json({
      message: "Workspace settings updated.",
      data: safe,
    });
  } catch (error) {
    console.error("updateWorkspaceSettings:", error.message);
    return res.status(500).json({
      message: "Could not update workspace settings.",
    });
  }
};

// GET /workspaces/:workspaceId/users
export const listWorkspaceUsers = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const workspace = await getWorkspaceOr404(
      req.params.workspaceId, res
    );
    if (!workspace) return;

    // await audit(req, "admin.workspace_users_listed", {
    //   workspaceId: workspace.id,
    //   targetType: "workspace",
    //   targetId: workspace.id,
    //   reason,
    // });

    const users = await orm().User
      .where({ workspaceId: workspace.id }).all();

    return res.json(pageRows(
      users.map(({ passwordHash, ...user }) => user), req
    ));
  } catch (error) {
    console.error("listWorkspaceUsers:", error.message);
    return res.status(500).json({
      message: "Could not list workspace users.",
    });
  }
};

// PATCH /users/:userId
export const updateUser = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const userId = req.params.userId;
    if (!validId(userId)) {
      return res.status(400).json({ message: "Invalid user id." });
    }

    const user = await orm().User.where({ id: userId }).first();
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    const allowed = ["name", "role", "status"];
    const changes = Object.fromEntries(
      Object.entries(req.body ?? {}).filter(([key]) =>
        allowed.includes(key)
      )
    );

    // A company user can never become a platform admin (platform admins belong to no company);
    // platform admins are created through /api/user/add-platform-admin.
    if (changes.role &&
        (!["company_admin", "company_viewer"].includes(changes.role) || user.role === ADMIN_ROLE)) {
      return res.status(400).json({ message: "Invalid role." });
    }

    if (changes.status &&
        !["active", "deactivated"].includes(changes.status)) {
      return res.status(400).json({ message: "Invalid user status." });
    }

    // Avoid accidental privilege escalation through this endpoint.
    if (user.id === req.user.id &&
        (changes.role || changes.status === "deactivated")) {
      return res.status(400).json({
        message: "You cannot change your own role or deactivate yourself here.",
      });
    }

    if (!Object.keys(changes).length) {
      return res.status(400).json({
        message: "No supported user changes provided.",
      });
    }

    await orm().User.where({ id: user.id }).update(changes);
    await audit(req, "admin.user_updated", {
      workspaceId: user.workspaceId ?? null,
      targetType: "user",
      targetId: user.id,
      reason: reasonFrom(req) || null,
      metadata: {
        changedFields: Object.keys(changes),
        previousRole: user.role,
        newRole: changes.role ?? user.role,
        previousStatus: user.status,
        newStatus: changes.status ?? user.status,
      },
    });

    const updated = await orm().User.where({ id: user.id }).first();
    const { passwordHash, twoFactorSecretEnc, ...safeUser } = updated ?? {};

    return res.json({
      message: "User updated.",
      data: safeUser,
    });
  } catch (error) {
    console.error("updateUser:", error.message);
    return res.status(500).json({
      message: "Could not update user.",
    });
  }
};

// GET /api-keys
export const listPlatformApiKeys = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const keys = await orm().ApiKey.all();

    // await audit(req, "admin.api_keys_listed", {
    //   reason,
    //   targetType: "api_key",
    // });

    const safeKeys = keys.map((key) => ({
      id: key.id,
      workspaceId: key.workspaceId,
      siteId: key.siteId ?? null,
      name: key.name,
      type: key.type,
      mode: key.mode,
      keyPrefix: key.keyPrefix,
      origins: key.origins,
      rateLimitPerMin: key.rateLimitPerMin,
      expiresAt: key.expiresAt ?? null,
      revokedAt: key.revokedAt ?? null,
      createdAt: key.createdAt,
    }));

    const search = String(req.query.search ?? "").toLowerCase();
    const filtered = search
      ? safeKeys.filter((key) =>
          `${key.keyPrefix ?? ""} ${key.workspaceId ?? ""}`
            .toLowerCase().includes(search))
      : safeKeys;

    return res.json(pageRows(filtered, req));
  } catch (error) {
    console.error("listPlatformApiKeys:", error.message);
    return res.status(500).json({
      message: "Could not list API keys.",
    });
  }
};

// POST /api-keys/:keyId/revoke
export const revokePlatformApiKey = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const key = await orm().ApiKey
      .where({ id: req.params.keyId }).first();

    if (!key) {
      return res.status(404).json({ message: "API key not found." });
    }

    if (key.revokedAt) {
      return res.json({ message: "API key is already revoked." });
    }

    // await audit(req, "admin.api_key_revoked", {
    //   workspaceId: key.workspaceId,
    //   targetType: "api_key",
    //   targetId: key.id,
    //   reason,
    //   metadata: { keyPrefix: key.keyPrefix },
    // });

    await orm().ApiKey.where({ id: key.id }).update({
      revokedAt: now(),
    });

    return res.json({ message: "API key revoked." });
  } catch (error) {
    console.error("revokePlatformApiKey:", error.message);
    return res.status(500).json({
      message: "Could not revoke API key.",
    });
  }
};

// GET /connectors
export const listPlatformConnectors = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const rows = await orm().Connector.all();

    // await audit(req, "admin.connectors_listed", {
    //   reason,
    //   targetType: "connector",
    // });

    // Never return config or encrypted secrets to the client.
    const safeRows = rows.map((connector) => ({
      id: connector.id,
      workspaceId: connector.workspaceId,
      type: connector.type,
      name: connector.name,
      publicId: connector.publicId,
      status: connector.status,
      errorCount: connector.errorCount,
      lastError: connector.lastError ?? null,
      createdAt: connector.createdAt,
    }));

    return res.json(pageRows(safeRows, req));
  } catch (error) {
    console.error("listPlatformConnectors:", error.message);
    return res.status(500).json({
      message: "Could not list connectors.",
    });
  }
};

// PATCH /connectors/:connectorId/status
export const setConnectorStatus = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const { status } = req.body ?? {};
    const allowedStatuses = ["active", "disabled", "error"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: "Invalid connector status.",
      });
    }

    const connector = await orm().Connector
      .where({ id: req.params.connectorId }).first();

    if (!connector) {
      return res.status(404).json({
        message: "Connector not found.",
      });
    }

    // await audit(req, "admin.connector_status_updated", {
    //   workspaceId: connector.workspaceId,
    //   targetType: "connector",
    //   targetId: connector.id,
    //   reason,
    //   metadata: {
    //     previousStatus: connector.status,
    //     newStatus: status,
    //   },
    // });

    await orm().Connector.where({ id: connector.id }).update({
      status,
    });

    return res.json({ message: "Connector status updated." });
  } catch (error) {
    console.error("setConnectorStatus:", error.message);
    return res.status(500).json({
      message: "Could not update connector status.",
    });
  }
};

// GET /webhooks
export const listPlatformWebhooks = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const rows = await orm().WebhookEndpoint.all();

    // await audit(req, "admin.webhooks_listed", {
    //   reason,
    //   targetType: "webhook",
    // });

    // Do not expose signingSecretEnc.
    const safeRows = rows.map((webhook) => ({
      id: webhook.id,
      workspaceId: webhook.workspaceId,
      url: webhook.url,
      eventTypes: webhook.eventTypes,
      isActive: webhook.isActive,
      consecutiveFailures: webhook.consecutiveFailures,
      createdAt: webhook.createdAt,
    }));

    return res.json(pageRows(safeRows, req));
  } catch (error) {
    console.error("listPlatformWebhooks:", error.message);
    return res.status(500).json({
      message: "Could not list webhooks.",
    });
  }
};

// PATCH /webhooks/:webhookId
export const updatePlatformWebhook = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;

    // const reason = await requireReason(req, res);
    // if (!reason) return;

    const webhook = await orm().WebhookEndpoint
      .where({ id: req.params.webhookId }).first();

    if (!webhook) {
      return res.status(404).json({
        message: "Webhook not found.",
      });
    }

    const changes = {};

    if (typeof req.body?.isActive === "boolean") {
      changes.isActive = req.body.isActive;
    }

    if (Array.isArray(req.body?.eventTypes)) {
      changes.eventTypes = req.body.eventTypes;
    }

    if (!Object.keys(changes).length) {
      return res.status(400).json({
        message: "Provide isActive and/or eventTypes.",
      });
    }

    // await audit(req, "admin.webhook_updated", {
    //   workspaceId: webhook.workspaceId,
    //   targetType: "webhook",
    //   targetId: webhook.id,
    //   reason,
    //   metadata: { changedFields: Object.keys(changes) },
    // });

    await orm().WebhookEndpoint
      .where({ id: webhook.id }).update(changes);

    return res.json({ message: "Webhook updated." });
  } catch (error) {
    console.error("updatePlatformWebhook:", error.message);
    return res.status(500).json({
      message: "Could not update webhook.",
    });
  }
};

export const getApiFromWorkspace = async (req, res) => {
  
}
export const deleteUser = async (req, res) => {
  try {
    if (!requirePlatformAdmin(req, res)) return;
    const userId = req.params.userId;
    if (!validId(userId)) return res.status(400).json({ message: "Invalid user id." });
    if (userId === req.user.id) return res.status(400).json({ message: "You cannot delete your own account." });

    const user = await orm().User.where({ id: userId }).first();
    if (!user) return res.status(404).json({ message: "User not found." });
    if (user.role === ADMIN_ROLE) {
      return res.status(400).json({ message: "Platform admins are removed through /api/user/platform-admins/:id." });
    }

    let outcome = "deleted";
    try {
      await orm().User.where({ id: user.id }).delete();
    } catch (err) {
      if (err?.code !== "23503") throw err;
      await orm().User.where({ id: user.id }).update({ status: "deactivated" });
      outcome = "deactivated";
    }
    await audit(req, outcome === "deleted" ? "admin.user_deleted" : "admin.user_deactivated", {
      workspaceId: user.workspaceId ?? null,
      targetType: "user",
      targetId: user.id,
      reason: reasonFrom(req) || null,
    });
    return res.status(200).json({ message: outcome === "deleted" ? "User deleted successfully" : "User has history, so it was deactivated instead", outcome });
  } catch (error) {
    console.error("platform deleteUser:", error.message);
    return res.status(500).json({ message: "Internal server error deleting user" });
  }
};
