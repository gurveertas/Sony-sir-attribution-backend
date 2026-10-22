/**
 * Website registration and ownership verification.
 * A site must be verified through DNS or a meta tag before live publishable keys can be used for it.
 * Verification fetches are guarded because the submitted domain is external input.
 */

import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import { db } from "../src/prisma/db.js";
import { writeAudit } from "../services/audit.js";

const MAX_SITES = 20;
const PG_UNIQUE_VIOLATION = "23505";
const VERIFY_HOST_PREFIX = "_attribution-verify"; // TXT record name. Must match addSite's instructions.
const META_NAME = "attribution-verify"; // <meta name="attribution-verify" content="...">
const MAX_ORIGINS = 20;
// "https://WWW.Glowsalon.com/pricing" -> "www.glowsalon.com". Returns null if invalid.
function normalizeDomain(raw) {
    try {
        const text = String(raw).trim();
        const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
        const host = url.hostname.toLowerCase();
        // needs a dot, only letters/digits/hyphens, so no localhost, IPs or junk
        if (!/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
        if (/^\d+(\.\d+)+$/.test(host)) return null; // plain IP address
        return host;
    } catch {
        return null;
    }
}

export const addSite = async (req, res) => {
    try {
        const workspaceId = req.user?.workspaceId;
        if (!workspaceId || req.user.role !== "company_admin") {
            return res.status(403).json({ message: "Only company admins can add a site" });
        }

        const { domain, verificationMethod = "dns_txt" } = req.body ?? {};

        // 1. Validate
        const host = normalizeDomain(domain);
        if (!host) {
            return res.status(400).json({ message: "Enter a valid domain, like example.com" });
        }
        if (!["dns_txt", "meta_tag"].includes(verificationMethod)) {
            return res.status(400).json({ message: "verificationMethod must be dns_txt or meta_tag" });
        }

        // 2. Site limit (.all() is the same fetch-many assumption as in the API key controller)
        const sites = await db.orm.public.Site.where({ workspaceId }).all();
        if (sites.length >= MAX_SITES) {
            return res.status(400).json({ message: `You can add at most ${MAX_SITES} sites` });
        }

        // 3. Duplicate check (the DB unique on workspaceId + domain also guards this)
        if (sites.some((s) => s.domain === host)) {
            return res.status(409).json({ message: "This site is already added" });
        }

        // 4. Build the origins and the ownership-proof token
        const bare = host.replace(/^www\./, "");
        const allowedOrigins = [...new Set([`https://${bare}`, `https://www.${bare}`])];
        const verificationToken = crypto.randomBytes(24).toString("hex");

        // 5. Save the site and the audit entry together
        const site = await db.transaction(async (tx) => {
            const created = await tx.orm.public.Site.create({
                workspaceId,
                domain: host,
                allowedOrigins,
                verificationMethod,
                verificationToken,
            });
            await writeAudit(tx.orm.public, {
                workspaceId,
                actorType: "user",
                actorUserId: req.user.id,
                action: "site.created",
                targetType: "site",
                targetId: created.id,
                metadata: { domain: host },
                ip: req.ip ?? null,
                userAgent: req.headers["user-agent"] ?? null,
            });
            return created;
        });

        // 6. Tell the admin how to prove ownership (the record name below is a proposal)
        const instructions =
            verificationMethod === "dns_txt"
                ? { type: "TXT", host: `_attribution-verify.${bare}`, value: verificationToken }
                : {
                    tag: `<meta name="attribution-verify" content="${verificationToken}">`,
                    where: "inside <head> on the home page",
                };

        return res.status(201).json({
            id: site.id,
            domain: site.domain,
            allowedOrigins: site.allowedOrigins,
            verificationMethod: site.verificationMethod,
            verifiedAt: null,
            instructions,
        });
    } catch (error) {
        if (error?.code === PG_UNIQUE_VIOLATION) {
            return res.status(409).json({ message: "This site is already added" });
        }
        console.error("addSite error:", error.message);
        return res.status(500).json({ message: "Internal server error while adding site" });
    }
};

function requireCompanyAdmin(req, res) {
    const workspaceId = req.user?.workspaceId;
    if (!workspaceId || req.user.role !== "company_admin") {
        res.status(403).json({ message: "Only company admins can manage sites" });
        return null;
    }
    return workspaceId;
}

// Always scoped by workspace: another company's site looks like "not found".
const findSite = (workspaceId, id) =>
    db.orm.public.Site.where({ id, workspaceId }).first();

const bareDomain = (domain) => domain.replace(/^www\./, "");

function buildInstructions(site) {
    if (site.verifiedAt || !site.verificationToken) return null;
    return site.verificationMethod === "dns_txt"
        ? { type: "TXT", host: `${VERIFY_HOST_PREFIX}.${bareDomain(site.domain)}`, value: site.verificationToken }
        : {
            tag: `<meta name="${META_NAME}" content="${site.verificationToken}">`,
            where: "inside <head> on the home page",
        };
}

// verificationToken is only needed until the site is verified, so it is never sent after.
function toPublic(site) {
    return {
        id: site.id,
        domain: site.domain,
        allowedOrigins: site.allowedOrigins,
        verificationMethod: site.verificationMethod,
        verifiedAt: site.verifiedAt ?? null,
        createdAt: site.createdAt,
        instructions: buildInstructions(site),
    };
}

async function audit(client, req, workspaceId, action, targetId, metadata = null) {
    await writeAudit(client.orm.public, {
        workspaceId,
        actorType: "user",
        actorUserId: req.user.id,
        action,
        targetType: "site",
        targetId,
        metadata,
        ip: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
    });
}

// An origin like "https://book.glowsalon.com" is allowed only if its host is the site's
// domain or a subdomain of it. This stops a company claiming origins it does not own.
function normalizeOriginForSite(raw, domain) {
    try {
        const url = new URL(String(raw).trim());
        if (url.protocol !== "https:") return null;
        if (url.pathname !== "/" || url.search || url.hash || url.username || url.port) return null;
        const host = url.hostname.toLowerCase();
        const bare = bareDomain(domain);
        if (host !== bare && !host.endsWith(`.${bare}`)) return null;
        return url.origin.toLowerCase();
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// GET /sites
// ---------------------------------------------------------------------------

export const listSites = async (req, res) => {
    try {
        const workspaceId = requireCompanyAdmin(req, res);
        if (!workspaceId) return;

        const sites = await db.orm.public.Site.where({ workspaceId }).all(); // .all() = your ORM's "fetch many"
        sites.sort((a, b) => String(a.domain).localeCompare(String(b.domain)));

        return res.status(200).json({ data: sites.map(toPublic) });
    } catch (error) {
        console.error("listSites error:", error.message);
        return res.status(500).json({ message: "Internal server error while listing sites" });
    }
};

// ---------------------------------------------------------------------------
// GET /sites/:id
// ---------------------------------------------------------------------------

export const getSite = async (req, res) => {
    try {
        const workspaceId = requireCompanyAdmin(req, res);
        if (!workspaceId) return;

        const site = await findSite(workspaceId, req.params.id);
        if (!site) return res.status(404).json({ message: "Site not found" });

        return res.status(200).json(toPublic(site));
    } catch (error) {
        console.error("getSite error:", error.message);
        return res.status(500).json({ message: "Internal server error while fetching site" });
    }
};

// ---------------------------------------------------------------------------
// PATCH /sites/:id
// Body: { allowedOrigins?, verificationMethod? }
// The domain cannot be changed. To use another domain, delete the site and add a new one.
// ---------------------------------------------------------------------------

export const updateSite = async (req, res) => {
    try {
        const workspaceId = requireCompanyAdmin(req, res);
        if (!workspaceId) return;

        const site = await findSite(workspaceId, req.params.id);
        if (!site) return res.status(404).json({ message: "Site not found" });

        const { allowedOrigins, verificationMethod } = req.body ?? {};
        const changes = {};

        if (allowedOrigins !== undefined) {
            if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || allowedOrigins.length > MAX_ORIGINS) {
                return res.status(400).json({ message: `allowedOrigins must have 1-${MAX_ORIGINS} entries` });
            }
            const origins = allowedOrigins.map((o) => normalizeOriginForSite(o, site.domain));
            if (origins.some((o) => o === null)) {
                return res.status(400).json({
                    message: `Each origin must be https://<${bareDomain(site.domain)} or a subdomain of it>, with no path`,
                });
            }
            changes.allowedOrigins = [...new Set(origins)];
        }

        // Switching method restarts verification: new token, and the old proof no longer counts.
        if (verificationMethod !== undefined && verificationMethod !== site.verificationMethod) {
            if (!["dns_txt", "meta_tag"].includes(verificationMethod)) {
                return res.status(400).json({ message: "verificationMethod must be dns_txt or meta_tag" });
            }
            changes.verificationMethod = verificationMethod;
            changes.verificationToken = crypto.randomBytes(24).toString("hex");
            changes.verifiedAt = null;
        }

        if (Object.keys(changes).length === 0) {
            return res.status(400).json({ message: "Nothing to update" });
        }

        await db.transaction(async (tx) => {
            await tx.orm.public.Site.where({ id: site.id }).update(changes);
            await audit(tx, req, workspaceId, "site.updated", site.id, { fields: Object.keys(changes) });
        });

        const updated = await findSite(workspaceId, site.id);
        return res.status(200).json(toPublic(updated));
    } catch (error) {
        console.error("updateSite error:", error.message);
        return res.status(500).json({ message: "Internal server error while updating site" });
    }
};

// ---------------------------------------------------------------------------
// DELETE /sites/:id
// ApiKey.siteId points at Site, so keys must be handled first. In ONE transaction we:
//   1. revoke the site's active keys (they stop working immediately),
//   2. detach all its keys (siteId = null) so the delete is allowed,
//   3. delete the site.
// ---------------------------------------------------------------------------

export const deleteSite = async (req, res) => {
    try {
        const workspaceId = requireCompanyAdmin(req, res);
        if (!workspaceId) return;

        const site = await findSite(workspaceId, req.params.id);
        if (!site) return res.status(404).json({ message: "Site not found" });

        const keys = await db.orm.public.ApiKey.where({ siteId: site.id, workspaceId }).all();
        const now = new Date().toISOString();

        await db.transaction(async (tx) => {
            for (const key of keys) {
                await tx.orm.public.ApiKey.where({ id: key.id }).update({
                    revokedAt: key.revokedAt ?? now,
                    siteId: null,
                });
            }
            await tx.orm.public.Site.where({ id: site.id }).delete(); // .delete() assumed from your ORM
            await audit(tx, req, workspaceId, "site.deleted", site.id, {
                domain: site.domain,
                keysRevoked: keys.filter((k) => !k.revokedAt).length,
            });
        });

        return res.status(204).end();
    } catch (error) {
        console.error("deleteSite error:", error.message);
        return res.status(500).json({ message: "Internal server error while deleting site" });
    }
};

// ---------------------------------------------------------------------------
// POST /sites/:id/verify-domain
// Checks that the company controls the domain, using the method chosen at creation.
// ---------------------------------------------------------------------------

// The server fetches a URL the user influences, so block internal addresses (SSRF).
function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split(".").map(Number);
        return (
            a === 0 || a === 10 || a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
        );
    }
    const v6 = ip.toLowerCase();
    return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") ||
        v6.startsWith("fe80") || v6.startsWith("::ffff:");
}

async function checkDns(site) {
    const name = `${VERIFY_HOST_PREFIX}.${bareDomain(site.domain)}`;
    try {
        const records = await dns.resolveTxt(name); // [[chunk, chunk], ...]
        return records.some((chunks) => chunks.join("") === site.verificationToken);
    } catch {
        return false; // no such record yet
    }
}

async function fetchHome(host) {
    const addresses = await dns.lookup(host, { all: true });
    if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) return null;
    const response = await fetch(`https://${host}/`, {
        redirect: "manual", // never follow redirects to somewhere we did not check
        signal: AbortSignal.timeout(5000),
        headers: { "user-agent": "AttributionVerifier/1.0" },
    });
    if (!response.ok) return null;
    return (await response.text()).slice(0, 200000);
}

async function checkMeta(site) {
    const bare = bareDomain(site.domain);
    // The home page often lives on either the apex or www, so try both.
    for (const host of [...new Set([site.domain, bare, `www.${bare}`])]) {
        try {
            const html = await fetchHome(host);
            if (!html) continue;
            const re = new RegExp(`<meta[^>]+name=["']${META_NAME}["'][^>]*content=["']${site.verificationToken}["']`, "i");
            const reAlt = new RegExp(`<meta[^>]+content=["']${site.verificationToken}["'][^>]*name=["']${META_NAME}["']`, "i");
            if (re.test(html) || reAlt.test(html)) return true;
        } catch {
            /* try the next host */
        }
    }
    return false;
}

export const verifySite = async (req, res) => {
    try {
        const workspaceId = requireCompanyAdmin(req, res);
        if (!workspaceId) return;

        const site = await findSite(workspaceId, req.params.id);
        if (!site) return res.status(404).json({ message: "Site not found" });
        if (site.verifiedAt) return res.status(200).json({ verified: true, message: "Already verified" });

        const isDev = process.env.NODE_ENV !== "production";
        const isMock = isDev && (req.body?.mock === true || req.query?.mock === "true");
        const ok = isMock || (site.verificationMethod === "dns_txt" ? await checkDns(site) : await checkMeta(site));

        if (!ok) {
            return res.status(422).json({
                verified: false,
                message:
                    site.verificationMethod === "dns_txt"
                        ? "TXT record not found yet. DNS changes can take a few minutes to hours to appear."
                        : "Meta tag not found on your home page. Publish it inside <head> and try again.",
                instructions: buildInstructions(site),
            });
        }

        await db.transaction(async (tx) => {
            await tx.orm.public.Site.where({ id: site.id }).update({ verifiedAt: new Date().toISOString() });
            await audit(tx, req, workspaceId, "site.verified", site.id, { method: isMock ? "mock_simulation" : site.verificationMethod });
        });

        return res.status(200).json({ verified: true, message: isMock ? "Domain verified via test simulation" : "Domain verified" });
    } catch (error) {
        console.error("verifySite error:", error.message);
        return res.status(500).json({ message: "Internal server error while verifying site" });
    }
};
