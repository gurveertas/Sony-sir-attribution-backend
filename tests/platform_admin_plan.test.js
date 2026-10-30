import "./setup.js";
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, makeRes } from "./fakeDb.js";
import { db } from "../src/prisma/db.js";
import { PLANS } from "../config/plans.js";

const fake = createFakeDb();
db.orm = fake.db.orm;

const { setWorkspacePlan, revokeWorkspacePlan } = await import("../controllers/platformAdminController.js");
const T = fake.tables;

beforeEach(() => {
  for (const k of Object.keys(T)) T[k] = [];
  T.Workspace = [
    {
      id: "ws1",
      slug: "acme",
      name: "Acme Corp",
      plan: "free",
      status: "active",
      billingInterval: "monthly",
      monthlyOrderLimit: PLANS.free.limits.monthlyOrders,
      subscriptionId: null,
    },
    {
      id: "ws2",
      slug: "beta",
      name: "Beta Inc",
      plan: "pro",
      status: "active",
      billingInterval: "monthly",
      monthlyOrderLimit: PLANS.pro.limits.monthlyOrders,
      subscriptionId: "sub_12345",
    },
  ];
});

const adminReq = (over = {}) => ({
  user: { id: "padmin1", role: "platform_admin", email: "platform@super.com" },
  headers: {},
  ip: "127.0.0.1",
  params: {},
  body: {},
  query: {},
  ...over,
});

const call = async (fn, req) => {
  const res = makeRes();
  await fn(req, res);
  return res;
};

test("setWorkspacePlan updates workspace plan to pro and syncs monthlyOrderLimit", async () => {
  const res = await call(setWorkspacePlan, adminReq({
    params: { workspaceId: "ws1" },
    body: { plan: "pro", billingInterval: "monthly", reason: "Enterprise customer upgraded via contract" },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.plan, "pro");
  assert.equal(res.body.data.monthlyOrderLimit, PLANS.pro.limits.monthlyOrders);
  assert.equal(res.body.data.billingInterval, "monthly");

  const row = T.Workspace.find((w) => w.id === "ws1");
  assert.equal(row.plan, "pro");
  assert.equal(row.monthlyOrderLimit, PLANS.pro.limits.monthlyOrders);

  const logs = T.AuditLog.filter((l) => l.action === "admin.workspace_plan_changed");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].workspaceId, "ws1");
  assert.equal(logs[0].metadata.newPlan, "pro");
});

test("setWorkspacePlan updates workspace plan to ultra with annual interval", async () => {
  const res = await call(setWorkspacePlan, adminReq({
    params: { workspaceId: "ws1" },
    body: { plan: "ultra", billingInterval: "annually" },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.plan, "ultra");
  assert.equal(res.body.data.monthlyOrderLimit, PLANS.ultra.limits.monthlyOrders);
  assert.equal(res.body.data.billingInterval, "annually");
});

test("setWorkspacePlan validates plan input and rejects invalid plans", async () => {
  const res = await call(setWorkspacePlan, adminReq({
    params: { workspaceId: "ws1" },
    body: { plan: "megaplan" },
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "validation_error");
});

test("revokeWorkspacePlan revokes paid tier and reverts to free", async () => {
  const res = await call(revokeWorkspacePlan, adminReq({
    params: { workspaceId: "ws2" },
    body: { reason: "Terms of service breach" },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.plan, "free");
  assert.equal(res.body.data.monthlyOrderLimit, PLANS.free.limits.monthlyOrders);
  assert.equal(res.body.data.subscriptionStatus, "canceled");
  assert.equal(res.body.data.subscriptionId, null);

  const row = T.Workspace.find((w) => w.id === "ws2");
  assert.equal(row.plan, "free");
  assert.equal(row.monthlyOrderLimit, PLANS.free.limits.monthlyOrders);

  const logs = T.AuditLog.filter((l) => l.action === "admin.workspace_plan_revoked");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].metadata.previousPlan, "pro");
  assert.equal(logs[0].metadata.revertedPlan, "free");
});

test("revokeWorkspacePlan rejects when workspace is already on free tier", async () => {
  const res = await call(revokeWorkspacePlan, adminReq({
    params: { workspaceId: "ws1" },
  }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "already_free");
});
