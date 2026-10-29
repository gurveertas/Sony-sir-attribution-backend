import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { makeRes, createFakeDb } from "./fakeDb.js";
import { inviteUser, createLocation, createChannelMappingRule } from "../controllers/workspaceController.js";
import { startAdOAuth } from "../controllers/workspaceToolsController.js";
import { sendMe } from "../controllers/authController.js";
import { db } from "../src/prisma/db.js";

test("inviteUser enforces team member limits based on plan tier", async () => {
    const fake = createFakeDb();
    db.orm = fake.db.orm;
    fake.tables.Workspace = [{ id: "ws_free", name: "Free Co", plan: "free" }];
    // Free plan allows up to 2 team members
    fake.tables.User = [
        { id: "u1", workspaceId: "ws_free", email: "user1@example.com" },
        { id: "u2", workspaceId: "ws_free", email: "user2@example.com" },
    ];
    fake.tables.Invite = [];
    fake.tables.Location = [];

    const req = {
        user: { id: "u1", workspaceId: "ws_free" },
        body: { email: "user3@example.com", role: "company_admin" },
        headers: { "user-agent": "test" },
    };
    const res = makeRes();

    await inviteUser(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "plan_limit_reached");
    assert.equal(res.body.limit, "teamMembers");
});

test("createLocation enforces location limits based on plan tier", async () => {
    const fake = createFakeDb();
    db.orm = fake.db.orm;
    fake.tables.Workspace = [{ id: "ws_free", name: "Free Co", plan: "free", timezone: "UTC", reportingCurrency: "USD" }];
    // Free plan allows 1 location
    fake.tables.Location = [
        { id: "loc1", workspaceId: "ws_free", name: "Headquarters" },
    ];

    const req = {
        user: { id: "u1", workspaceId: "ws_free" },
        body: { name: "Branch 2" },
        headers: { "user-agent": "test" },
    };
    const res = makeRes();

    await createLocation(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "plan_limit_reached");
    assert.equal(res.body.limit, "locations");
});

test("createChannelMappingRule enforces customChannelRules limits based on plan tier", async () => {
    const fake = createFakeDb();
    db.orm = fake.db.orm;
    fake.tables.Workspace = [{ id: "ws_free", name: "Free Co", plan: "free" }];
    // Free plan allows 3 rules
    fake.tables.ChannelMappingRule = [
        { id: "r1", workspaceId: "ws_free", priority: 1, match: { source: "google" }, channel: "search" },
        { id: "r2", workspaceId: "ws_free", priority: 2, match: { source: "fb" }, channel: "social" },
        { id: "r3", workspaceId: "ws_free", priority: 3, match: { source: "newsletter" }, channel: "email" },
    ];

    const req = {
        user: { id: "u1", workspaceId: "ws_free" },
        body: { priority: 4, match: { source: "partner" }, channel: "affiliate" },
        headers: { "user-agent": "test" },
    };
    const res = makeRes();

    await createChannelMappingRule(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "plan_limit_reached");
    assert.equal(res.body.limit, "customChannelRules");
});

test("startAdOAuth enforces ad account limit based on plan tier", async () => {
    const fake = createFakeDb();
    db.orm = fake.db.orm;
    fake.tables.Workspace = [{ id: "ws_free", name: "Free Co", plan: "free" }];
    // Free plan allows 1 ad account
    fake.tables.AdAccount = [
        { id: "ad1", workspaceId: "ws_free", platform: "meta" },
    ];

    const req = {
        user: { id: "u1", workspaceId: "ws_free" },
        params: { platform: "meta" },
        headers: { "user-agent": "test" },
    };
    const res = makeRes();

    await startAdOAuth(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "plan_limit_reached");
    assert.equal(res.body.limit, "adAccounts");
});

test("sendMe includes subscription and plan fields in workspace payload", async () => {
    const fake = createFakeDb();
    db.orm = fake.db.orm;
    fake.tables.Workspace = [{
        id: "ws_pro",
        name: "Pro Co",
        status: "active",
        timezone: "America/New_York",
        reportingCurrency: "USD",
        defaultModel: "linear",
        weekStart: "monday",
        plan: "pro",
        subscriptionStatus: "active",
        billingInterval: "monthly",
        trialEndsAt: null,
        currentPeriodEndsAt: "2026-11-29T00:00:00.000Z",
        cancelAtPeriodEnd: false,
    }];

    const req = {
        cookies: {},
        user: { id: "u1", workspaceId: "ws_pro", twoFactorEnabled: false, mfaPending: false, allowedLocationIds: [] },
        headers: {},
    };
    const res = makeRes();

    await sendMe(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workspace.plan, "pro");
    assert.equal(res.body.workspace.subscriptionStatus, "active");
    assert.equal(res.body.workspace.billingInterval, "monthly");
    assert.equal(res.body.workspace.currentPeriodEndsAt, "2026-11-29T00:00:00.000Z");
});
