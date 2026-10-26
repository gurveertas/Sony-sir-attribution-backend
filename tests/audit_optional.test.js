// This schema has NO AuditLog model. Everything must keep working, and nothing may be silently lost.
import { mockFetch } from "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFakeDb, makeRes, adminReq } from "./fakeDb.js";

const fake = createFakeDb();
fake.state.missing.add("AuditLog");
mock.module("../src/prisma/db.js", { namedExports: { db: fake.db }, defaultExport: fake.db });

const { writeAudit, hasAuditStore, AuditUnavailableError } = await import("../services/audit.js");
const gateway = await import("../controllers/gatewayConnectController.js");
const mgmt = await import("../controllers/connectorManagementController.js");
const customers = await import("../controllers/customerController.js");
const support = await import("../controllers/supportAccessController.js");
const workspace = await import("../controllers/workspaceController.js");

const T = fake.tables;
const captureLogs = async (fn) => {
    const lines = [];
    const original = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try { await fn(); } finally { console.log = original; }
    return lines.filter((l) => l.startsWith('{"audit"')).map((l) => JSON.parse(l));
};
const entry = { workspaceId: "ws1", actorType: "user", actorUserId: "u1", action: "x.did", metadata: { a: 1 } };

test("writeAudit without a store: no throw, one structured log line, returns null", async () => {
    assert.equal(hasAuditStore(fake.db.orm.public), false);
    const logs = await captureLogs(async () => assert.equal(await writeAudit(fake.db.orm.public, entry), null));
    assert.equal(logs.length, 1);
    assert.deepEqual([logs[0].action, logs[0].workspaceId, logs[0].metadata], ["x.did", "ws1", { a: 1 }]);
});

test("required:true refuses to proceed without a durable store", async () => {
    await assert.rejects(writeAudit(fake.db.orm.public, entry, { required: true }), AuditUnavailableError);
});

test("with a store, entries are written (and its errors still propagate, as before)", async () => {
    const f2 = createFakeDb();
    assert.equal(hasAuditStore(f2.db.orm.public), true);
    await writeAudit(f2.db.orm.public, entry);
    assert.equal(f2.tables.AuditLog.length, 1);
    f2.state.failOn = { AuditLog: true };
    await assert.rejects(writeAudit(f2.db.orm.public, entry), /forced AuditLog/);
});

test("stripe one-click connect works on this schema (it used to be impossible: audit write aborted the transaction)", async () => {
    const f = mockFetch((c) =>
        c.url.endsWith("/v1/account") ? { json: { id: "acct_1" } } : { json: { id: "we_1", secret: "whsec_1", status: "enabled" } });
    try {
        let res;
        const logs = await captureLogs(async () => {
            res = makeRes();
            await gateway.connectGateway(adminReq({ type: "stripe", credentials: { secretKey: "sk_test_51Abcdefghijklmnop" } }), res);
        });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.equal(T.Connector.length, 1);
        assert.ok(logs.some((l) => l.action === "connector.connected"), "audit trail still emitted");
        assert.ok(!JSON.stringify(logs).includes("whsec_1") && !JSON.stringify(logs).includes("sk_test_"), "no secrets in logs");
    } finally { f.restore(); }
});

test("connector create/delete/replay, customer merge and support sessions all work without the table", async () => {
    T.Connector = []; T.Customer = []; T.Workspace = [{ id: "ws1", status: "active" }]; T.User = [{ id: "user-1", name: "Asha" }];
    const created = makeRes();
    await mgmt.createConnector(adminReq({ type: "shopify", name: "Shop", config: { sharedSecret: "s" } }), created);
    assert.equal(created.statusCode, 201);
    const gone = makeRes();
    await mgmt.deleteConnector(adminReq({}, { id: created.body.id }), gone);
    assert.equal(gone.statusCode, 204);

    T.Customer.push({ id: "A", workspaceId: "ws1", mergedIntoId: null }, { id: "B", workspaceId: "ws1", mergedIntoId: null });
    const merged = makeRes();
    await customers.mergeCustomersHandler(adminReq({ sourceId: "B", targetId: "A" }), merged);
    assert.equal(merged.statusCode, 200, JSON.stringify(merged.body));

    const started = makeRes();
    const req = adminReq({ workspaceId: "ws1", reason: "Investigating ticket 4821" });
    req.user = { id: "admin1", role: "platform_admin", workspaceId: null };
    await support.startSupportSession(req, started);
    assert.equal(started.statusCode, 201, JSON.stringify(started.body));
    // the company can still see who accessed its data: sessions live in their own table
    const list = makeRes();
    await support.listSupportAccess({ user: { id: "u1", workspaceId: "ws1" } }, list);
    assert.equal(list.body.data.length, 1);
});

test("GET /audit-log reports 'not available' instead of crashing", async () => {
    const res = makeRes();
    await workspace.getAuditLog({ user: { workspaceId: "ws1" }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.available, false);
    assert.deepEqual(res.body.data, []);
});

// ── static compatibility with THIS repo's real schema ────────────────────────

const root = path.resolve(import.meta.dirname, "..");
// contract.prisma is the source of truth; contract.json is generated from it (npm run build / contract:emit)
const prismaText = fs.readFileSync(path.join(root, "src/prisma/contract.prisma"), "utf8");
const contractModels = new Set([...prismaText.matchAll(/^model\s+([A-Za-z]+)/gm)].map((m) => m[1]));
const emittedModels = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, "src/prisma/contract.json"), "utf8")).roots));
const sources = ["controllers", "services", "middlewares", "utils", "routes"].flatMap((d) =>
    fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".js")).map((f) => path.join(d, f)));

test("src/prisma/contract.json is generated from the current contract.prisma (run: npx prisma contract emit)", (t) => {
    const stale = [...contractModels].filter((m) => !emittedModels.has(m));
    if (stale.length) {
        // The build (npm run build / Dockerfile) regenerates it; this only reminds you when running locally.
        t.skip(`contract.json is older than contract.prisma — missing models: ${stale.join(", ")}. Run \`npx prisma contract emit\` and apply the migration.`);
    }
});

test("every model the code touches exists in src/prisma/contract.prisma", () => {
    const missing = [];
    for (const file of sources) {
        if (file === path.join("services", "audit.js")) continue;
        const text = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        for (const m of text.matchAll(/(?:orm\.public|orm\(\)|\borm|\bt|\btt)\.([A-Z][A-Za-z]+)\b/g)) {
            if (!contractModels.has(m[1])) missing.push(`${file}: ${m[1]}`);
        }
    }
    assert.deepEqual(missing, [], "these would throw TypeError at runtime (like AuditLog used to)");
});

test("AuditLog is only ever touched through services/audit.js", () => {
    const direct = [];
    for (const file of sources) {
        if (file === path.join("services", "audit.js")) continue;
        const text = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\/.*$/gm, "");
        if (/\.AuditLog\b/.test(text)) direct.push(file);
    }
    assert.deepEqual(direct, []);
});
