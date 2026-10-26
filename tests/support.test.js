import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";

const fake = createFakeDb();
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const calls = [];
const spy = (name) => async (req, res, wid) => { calls.push({ name, wid, maskPii: req.maskPii }); return res.status(200).json({ ok: name }); };
mock.module("../controllers/reportsController.js", {
    namedExports: {
        ...Object.fromEntries(["getDashboardOverview", "getSummaryReport", "getCampaignsReport", "getChannelsReport", "getLocationsReport", "getTrendReport", "getCustomersReport", "getCacReport", "getSpendReport", "getBookingsReport", "getJourneysReport", "getCoverageReport", "getDataQualityReport", "getAlerts"].map((n) => [n, spy(n)])),
        resolveListWindow: async () => ({ fromIso: null, toIso: null }),
    },
});
mock.module("../controllers/customerController.js", { namedExports: { listCustomers: spy("listCustomers"), getCustomerJourney: spy("getCustomerJourney") } });

const support = await import("../controllers/supportAccessController.js");
const view = await import("../controllers/platformAdminDashboardController.js");
const svc = await import("../services/supportAccess.js");

const T = fake.tables;
const reset = () => {
    for (const k of Object.keys(T)) T[k] = [];
    calls.length = 0;
    delete process.env.SUPPORT_ACCESS_REQUIRED;
    T.Workspace.push({ id: "ws1" }, { id: "ws2" });
    T.User.push({ id: "admin1", name: "Asha (Support)" }, { id: "admin2", name: "Other Admin" });
};
const admin = (id = "admin1") => ({ id, role: "platform_admin", workspaceId: null });
const req = (over = {}) => ({ user: admin(), body: {}, params: {}, query: {}, headers: { "user-agent": "t" }, ip: "5.5.5.5", originalUrl: "/api/view/workspace/ws1?from=2026-01-01", ...over });
const start = async (body, user = admin()) => { const res = makeRes(); await support.startSupportSession(req({ user, body }), res); return res; };

test("start: reason is mandatory (min length) and bounded; duration bounded; workspace must exist", async () => {
    reset();
    assert.equal((await start({ workspaceId: "ws1" })).body.code, "reason_required");
    assert.equal((await start({ workspaceId: "ws1", reason: "short" })).body.code, "reason_required");
    assert.equal((await start({ workspaceId: "ws1", reason: "x".repeat(501) })).statusCode, 400);
    assert.equal((await start({ workspaceId: "ws1", reason: "Investigating ticket 4821", durationMinutes: 999 })).statusCode, 400);
    assert.equal((await start({ workspaceId: "ws1", reason: "Investigating ticket 4821", maskPii: "no" })).statusCode, 400);
    assert.equal((await start({ workspaceId: "nope", reason: "Investigating ticket 4821" })).statusCode, 404);
    assert.equal(T.SupportAccessSession.length, 0);
});

test("start: creates a masked, expiring session and writes a company-visible audit entry", async () => {
    reset();
    const res = await start({ workspaceId: "ws1", reason: "Investigating ticket 4821", durationMinutes: 45 });
    assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    assert.equal(res.body.maskPii, true);
    const minutes = (new Date(res.body.expiresAt) - new Date(res.body.startedAt ?? Date.now())) / 60000;
    assert.ok(minutes > 40 && minutes < 50);
    const log = T.AuditLog.find((l) => l.action === "support.session_started");
    assert.deepEqual([log.workspaceId, log.actorType, log.actorUserId, log.reason], ["ws1", "platform_admin", "admin1", "Investigating ticket 4821"]);
});

const open = async (over = {}) => (await start({ workspaceId: "ws1", reason: "Investigating ticket 4821", ...over })).body;

test("view WITHOUT a session is refused and the data handler never runs", async () => {
    reset();
    const res = makeRes();
    await view.getWorkspaceDashboard(req({ params: { workspaceId: "ws1" } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "support_session_required");
    assert.equal(calls.length, 0);
    assert.equal(T.AuditLog.filter((l) => l.action === "support.data_viewed").length, 0);
});

test("view WITH a valid session: allowed, PII masked by default, and EVERY request is audited for the company", async () => {
    reset();
    const s = await open();
    for (const fn of [view.getWorkspaceDashboard, view.listCustomerView, view.getSummaryReportView]) {
        const res = makeRes();
        await fn(req({ params: { workspaceId: "ws1" }, headers: { "x-support-session": s.id } }), res);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    }
    assert.deepEqual(calls.map((c) => [c.name, c.wid, c.maskPii]), [["getDashboardOverview", "ws1", true], ["listCustomers", "ws1", true], ["getSummaryReport", "ws1", true]]);
    const views = T.AuditLog.filter((l) => l.action === "support.data_viewed");
    assert.equal(views.length, 3);
    assert.ok(views.every((l) => l.workspaceId === "ws1" && l.reason === "Investigating ticket 4821" && l.metadata.sessionId === s.id));
    assert.equal(views[0].metadata.path, "/api/view/workspace/ws1", "query string (may hold filters) is not logged");
});

test("unmasked session is possible only when explicitly requested, and is flagged in the audit log", async () => {
    reset();
    const s = await open({ maskPii: false });
    const res = makeRes();
    await view.listCustomerView(req({ params: { workspaceId: "ws1" }, headers: { "x-support-session": s.id } }), res);
    assert.equal(calls[0].maskPii, false);
    assert.equal(T.AuditLog.find((l) => l.action === "support.session_started").metadata.piiUnmasked, true);
    assert.equal(T.AuditLog.find((l) => l.action === "support.data_viewed").metadata.piiUnmasked, true);
});

test("a session cannot be reused by another admin, for another workspace, after ending, or after expiry", async () => {
    reset();
    const s = await open();
    const attempt = async (r) => { const res = makeRes(); await view.getWorkspaceDashboard(r, res); return res; };
    const hdr = { "x-support-session": s.id };

    assert.equal((await attempt(req({ user: admin("admin2"), params: { workspaceId: "ws1" }, headers: hdr }))).body.code, "support_session_invalid");
    assert.equal((await attempt(req({ params: { workspaceId: "ws2" }, headers: hdr }))).body.code, "support_session_invalid");
    assert.equal((await attempt(req({ params: { workspaceId: "ws1" }, headers: { "x-support-session": "made-up" } }))).body.code, "support_session_invalid");

    T.SupportAccessSession[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.equal((await attempt(req({ params: { workspaceId: "ws1" }, headers: hdr }))).body.code, "support_session_expired");

    T.SupportAccessSession[0].expiresAt = new Date(Date.now() + 60000).toISOString();
    const end = makeRes();
    await support.endSupportSession(req({ params: { id: s.id } }), end);
    assert.equal(end.statusCode, 200);
    assert.equal((await attempt(req({ params: { workspaceId: "ws1" }, headers: hdr }))).body.code, "support_session_ended");
    assert.equal(calls.length, 0);
    assert.ok(T.AuditLog.some((l) => l.action === "support.session_ended"));
});

test("only the owner can end a session; ending twice is harmless", async () => {
    reset();
    const s = await open();
    const other = makeRes();
    await support.endSupportSession(req({ user: admin("admin2"), params: { id: s.id } }), other);
    assert.equal(other.statusCode, 404);
    const a = makeRes(); await support.endSupportSession(req({ params: { id: s.id } }), a);
    const b = makeRes(); await support.endSupportSession(req({ params: { id: s.id } }), b);
    assert.equal(b.body.alreadyEnded, true);
});

test("REGRESSION: a non-admin hitting a view route gets 403 and the data handler does NOT run", async () => {
    reset();
    const res = makeRes();
    await view.getWorkspaceDashboard(req({ user: { id: "u1", role: "company_admin", workspaceId: "ws1" }, params: { workspaceId: "ws1" } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0);
    const missing = makeRes();
    await view.getWorkspaceDashboard(req({ params: { workspaceId: "nope" } }), missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(calls.length, 0);
});

test("SUPPORT_ACCESS_REQUIRED=false (temporary migration aid) skips the session but still masks PII", async () => {
    reset();
    process.env.SUPPORT_ACCESS_REQUIRED = "false";
    const res = makeRes();
    await view.listCustomerView(req({ params: { workspaceId: "ws1" } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(calls[0].maskPii, true);
});

test("company can list who accessed its data, why and when (and sees nothing of other companies)", async () => {
    reset();
    await open();
    await start({ workspaceId: "ws2", reason: "Different company's ticket" });
    const res = makeRes();
    await support.listSupportAccess({ user: { id: "u1", workspaceId: "ws1", role: "company_admin" } }, res);
    assert.equal(res.body.data.length, 1);
    assert.deepEqual([res.body.data[0].supportAgent, res.body.data[0].reason, res.body.data[0].maskPii], ["Asha (Support)", "Investigating ticket 4821", true]);
    assert.ok(!JSON.stringify(res.body).includes("admin1"), "internal admin ids are not exposed");
    assert.ok(!JSON.stringify(res.body).includes("Different company"));
});

test("validateStartInput trims and applies defaults", () => {
    assert.deepEqual(svc.validateStartInput({ workspaceId: " ws1 ", reason: "  Investigating ticket 4821  " }), { workspaceId: "ws1", reason: "Investigating ticket 4821", minutes: 30, maskPii: true });
});
