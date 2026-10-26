// Team invites (list / edit / resend / delete), email link domains, and API key rotation clean-up.
import "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });
const sent = [];
let emailFails = false;
mock.module("../services/emailServices.js", {
    namedExports: {
        sendEmail: async (msg) => {
            if (emailFails) throw new Error("Unable to send email");
            sent.push(msg);
            return { id: "e1" };
        },
    },
});

const ws = await import("../controllers/workspaceController.js");
const keys = await import("../controllers/apiKeyController.js");
const { frontendBase, safeFrontendOrigin } = await import("../utils/frontendUrl.js");
const ENV = (await import("../utils/env.js")).default;

const T = fake.tables;
const admin = { id: "admin1", role: "company_admin", workspaceId: "ws1", name: "Ann" };
const call = async (fn, req) => {
    const res = makeRes();
    await fn({ headers: {}, ip: "1.2.3.4", query: {}, params: {}, body: {}, user: admin, ...req }, res);
    return res;
};
const linkOf = (msg) => msg.html.match(/href="([^"]+)"/)[1];
const tokenOf = (msg) => new URL(linkOf(msg)).searchParams.get("token");

beforeEach(() => {
    for (const k of Object.keys(T)) T[k] = [];
    sent.length = 0;
    emailFails = false;
    T.Workspace = [{ id: "ws1", slug: "acme", name: "Acme", status: "active" }, { id: "ws2", slug: "beta", name: "Beta", status: "active" }];
    T.User = [{ id: "admin1", workspaceId: "ws1", email: "ann@acme.test", name: "Ann", role: "company_admin", status: "active" }];
    T.Location = [{ id: "loc1", workspaceId: "ws1", name: "Main" }, { id: "locB", workspaceId: "ws2", name: "Other company" }];
});

// ── email links ─────────────────────────────────────────────────────────────

test("email links use the dashboard origin the admin is on, but only when it is an allowed origin", () => {
    assert.equal(frontendBase({ headers: { origin: "https://asf-tas.vercel.app" } }), "https://asf-tas.vercel.app");
    assert.equal(frontendBase({ headers: { referer: "https://asf-tas.vercel.app/team?x=1" } }), "https://asf-tas.vercel.app");
    // a forged origin never reaches an email
    assert.equal(frontendBase({ headers: { origin: "https://evil.example" } }), ENV.FRONTEND_URL);
    assert.equal(frontendBase({ headers: {} }), ENV.FRONTEND_URL);
    assert.equal(safeFrontendOrigin("https://evil.example"), ENV.FRONTEND_URL);
});

test("the invite email links to /accept-invite on the admin's dashboard, and the link token works", async () => {
    const res = await call(ws.inviteUser, { headers: { origin: "https://asf-tas.vercel.app" }, body: { email: "Bob@Acme.test", role: "company_viewer", allowedLocationIds: ["loc1"] } });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(sent.length, 1);
    const link = new URL(linkOf(sent[0]));
    assert.equal(link.origin, "https://asf-tas.vercel.app");
    assert.equal(link.pathname, "/accept-invite");
    assert.equal(T.Invite[0].tokenHash, crypto.createHash("sha256").update(tokenOf(sent[0])).digest("hex"));
});

// ── invites CRUD ────────────────────────────────────────────────────────────

test("open invites can be listed, edited, resent and deleted; a deleted invite link stops working", async () => {
    await call(ws.inviteUser, { body: { email: "bob@acme.test", role: "company_viewer" } });
    const firstToken = tokenOf(sent[0]);
    const id = T.Invite[0].id;

    let list = await call(ws.listInvites, {});
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].status, "pending");
    assert.equal(list.body.data[0].invitedByName, "Ann");
    assert.equal(list.body.data[0].tokenHash, undefined, "the token hash is never returned");

    // edit role and locations
    let res = await call(ws.updateInvite, { params: { id }, body: { allowedLocationIds: ["loc1"] } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(T.Invite[0].allowedLocationIds, ["loc1"]);
    res = await call(ws.updateInvite, { params: { id }, body: { allowedLocationIds: ["locB"] } });
    assert.equal(res.statusCode, 400, "another company's location is refused");
    res = await call(ws.updateInvite, { params: { id }, body: { role: "company_admin" } });
    assert.equal(T.Invite[0].role, "company_admin");
    assert.deepEqual(T.Invite[0].allowedLocationIds, [], "admins see every location");

    // resend: new link, the old one stops working, expiry renewed
    T.Invite[0].expiresAt = new Date(Date.now() - 1000).toISOString(); // expired invites can be resent
    list = await call(ws.listInvites, {});
    assert.equal(list.body.data[0].status, "expired");
    res = await call(ws.resendInvite, { params: { id } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(sent.length, 2);
    const secondToken = tokenOf(sent[1]);
    assert.notEqual(secondToken, firstToken);
    assert.ok(new Date(T.Invite[0].expiresAt) > new Date(Date.now() + 6 * 86_400_000));
    res = await call(ws.acceptInvite, { body: { token: firstToken, name: "Bob", password: "LongPassword1" } });
    assert.equal(res.statusCode, 400, "the old link no longer works");

    // delete (revoke): link stops working, invite leaves the list, the email can be invited again
    res = await call(ws.revokeInvite, { params: { id } });
    assert.equal(res.statusCode, 200);
    assert.ok(T.Invite[0].revokedAt);
    assert.equal((await call(ws.listInvites, {})).body.data.length, 0);
    res = await call(ws.acceptInvite, { body: { token: secondToken, name: "Bob", password: "LongPassword1" } });
    assert.equal(res.statusCode, 400);
    res = await call(ws.inviteUser, { body: { email: "bob@acme.test", role: "company_viewer" } });
    assert.equal(res.statusCode, 201, "re-inviting after a delete works");

    // audit trail
    const actions = T.AuditLog.map((a) => a.action);
    for (const a of ["invite.sent", "invite.updated", "invite.resent", "invite.revoked"]) assert.ok(actions.includes(a), a);
});

test("another company's invite cannot be read, changed or deleted", async () => {
    T.Invite = [{ id: "inv-b", workspaceId: "ws2", email: "x@beta.test", role: "company_viewer", allowedLocationIds: [], invitedBy: "u2", tokenHash: "h", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: "2026-01-01" }];
    assert.equal((await call(ws.listInvites, {})).body.data.length, 0);
    assert.equal((await call(ws.updateInvite, { params: { id: "inv-b" }, body: { role: "company_admin" } })).statusCode, 404);
    assert.equal((await call(ws.resendInvite, { params: { id: "inv-b" } })).statusCode, 404);
    assert.equal((await call(ws.revokeInvite, { params: { id: "inv-b" } })).statusCode, 404);
    assert.equal(T.Invite[0].revokedAt, undefined);
});

test("an accepted invite cannot be deleted or resent; a duplicate open invite is refused", async () => {
    await call(ws.inviteUser, { body: { email: "bob@acme.test", role: "company_viewer" } });
    const dup = await call(ws.inviteUser, { body: { email: "bob@acme.test", role: "company_viewer" } });
    assert.equal(dup.statusCode, 409);
    assert.equal(dup.body.code, "invite_exists");
    const res = await call(ws.acceptInvite, { body: { token: tokenOf(sent[0]), name: "Bob", password: "LongPassword1" } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const id = T.Invite[0].id;
    assert.equal((await call(ws.revokeInvite, { params: { id } })).statusCode, 409);
    assert.equal((await call(ws.resendInvite, { params: { id } })).statusCode, 409);
});

test("when the email fails, the invite still exists and the admin is told to resend", async () => {
    emailFails = true;
    const res = await call(ws.inviteUser, { body: { email: "carl@acme.test", role: "company_viewer" } });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.emailed, false);
    assert.match(res.body.message, /Resend/);
    assert.equal((await call(ws.resendInvite, { params: { id: T.Invite[0].id } })).statusCode, 502);
});

// ── API key rotation: behaviour unchanged, the list only says what each key is ──

const key = (over = {}) => ({ workspaceId: "ws1", type: "publishable", mode: "live", name: "site", keyHash: crypto.randomUUID(), keyPrefix: "pk_live_old", allowedOrigins: [], rateLimitPerMin: 600, revokedAt: null, createdAt: new Date().toISOString(), ...over });

test("rotation is unchanged: the old key keeps working for 24 hours by default and stays listed", async () => {
    T.ApiKey = [key({ id: "k1" })];
    const res = await call(keys.rotateApiKey, { params: { id: "k1" }, body: {} });
    assert.equal(res.statusCode, 201);
    const old = T.ApiKey.find((k) => k.id === "k1");
    assert.equal(old.revokedAt ?? null, null, "not revoked");
    const hours = (new Date(old.expiresAt) - Date.now()) / 3600_000;
    assert.ok(hours > 23.9 && hours <= 24, "24 hour grace period");
    const list = (await call(keys.listApiKeys, {})).body.data;
    assert.equal(list.length, 2, "both keys are still listed");
});

test("the key list marks each key: active, replaced (with its replacement), expired, revoked", async () => {
    T.ApiKey = [key({ id: "k1" })];
    const rotated = await call(keys.rotateApiKey, { params: { id: "k1" }, body: {} });
    let list = (await call(keys.listApiKeys, {})).body.data;
    const byId = (id) => list.find((k) => k.id === id);
    assert.equal(byId(rotated.body.id).status, "active");
    assert.equal(byId(rotated.body.id).replacedById, null);
    assert.equal(byId("k1").status, "replaced");
    assert.equal(byId("k1").replacedById, rotated.body.id);
    assert.equal(byId("k1").replacedByPrefix, rotated.body.keyPrefix);

    // grace period over: still listed (nothing is deleted), now marked expired
    T.ApiKey.find((k) => k.id === "k1").expiresAt = new Date(Date.now() - 1000).toISOString();
    list = (await call(keys.listApiKeys, {})).body.data;
    assert.equal(byId("k1").status, "expired");
    assert.equal(T.ApiKey.find((k) => k.id === "k1").revokedAt ?? null, null, "the row is not changed");

    // revoked keys show their status when asked for
    T.ApiKey.push(key({ id: "k9", revokedAt: new Date().toISOString() }));
    list = (await call(keys.listApiKeys, { query: { includeRevoked: "true" } })).body.data;
    assert.equal(byId("k9").status, "revoked");
});
