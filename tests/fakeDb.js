// Tiny in-memory stand-in for db.orm.public + db.transaction, enough for the connector controllers.
import crypto from "node:crypto";

const colProxy = () =>
    new Proxy({}, {
        get: (_t, field) => ({
            eq: (v) => ({ field, op: "eq", v }),
            in: (v) => ({ field, op: "in", v }),
            gte: (v) => ({ field, op: "gte", v }),
            lte: (v) => ({ field, op: "lte", v }),
            asc: () => ({ field, dir: "asc" }),
            desc: () => ({ field, dir: "desc" }),
            isNull: () => ({ field, op: "null" }),
        }),
    });

export function createFakeDb({ failOn = {} } = {}) {
    const tables = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = [])), set: (t, k, v) => ((t[k] = v), true) });
    const state = { failOn, missing: new Set() };

    const matches = (row, conds) =>
        conds.every((c) => {
            if (typeof c === "function") {
                const d = c(colProxy());
                const val = row[d.field];
                switch (d.op) {
                    case "null": return val == null;
                    case "in": return d.v.includes(val);
                    case "gte": return val >= d.v;
                    case "lte": return val <= d.v;
                    default: return val === d.v;
                }
            }
            return Object.entries(c).every(([k, v]) => row[k] === v);
        });

    const query = (name, conds, order = null, lim = null) => ({
        where: (c) => query(name, [...conds, c], order, lim),
        orderBy: (fn) => query(name, conds, fn(colProxy()), lim),
        limit: (n) => query(name, conds, order, n),
        first: async () => {
            const row = tables[name].find((r) => matches(r, conds));
            return row ? { ...row } : null;
        },
        all: async () => {
            let rows = tables[name].filter((r) => matches(r, conds)).map((r) => ({ ...r }));
            if (order) rows.sort((a, b) => (a[order.field] > b[order.field] ? 1 : -1) * (order.dir === "desc" ? -1 : 1));
            return lim ? rows.slice(0, lim) : rows;
        },
        update: async (changes) => {
            for (const r of tables[name]) if (matches(r, conds)) Object.assign(r, changes);
        },
        delete: async () => {
            const doomed = tables[name].filter((r) => matches(r, conds));
            if (name === "Connector") {
                for (const c of doomed) {
                    if (tables.RawEvent.some((e) => e.connectorId === c.id)) {
                        throw new Error('update or delete on table "Connector" violates foreign key constraint on table "RawEvent"');
                    }
                }
            }
            tables[name] = tables[name].filter((r) => !doomed.includes(r));
        },
    });

    const model = (name) => ({
        create: async (data) => {
            if (state.failOn[name]) throw new Error(`forced ${name}.create failure`);
            const row = {
                id: crypto.randomUUID(),
                status: "pending",
                errorCount: 0,
                replayCount: 0,
                lastEventAt: null,
                lastError: null,
                lastErrorAt: null,
                receivedAt: new Date(Date.now() + tables[name].length).toISOString(),
                createdAt: new Date().toISOString(),
                config: null,
                secretsEnc: null,
                ...data,
            };
            tables[name].push(row);
            return { ...row };
        },
        where: (c) => query(name, [c]),
        // the real ORM also allows Model.all() / Model.first() without a filter
        all: () => query(name, []).all(),
        first: () => query(name, []).first(),
    });

    const orm = { public: new Proxy({}, { get: (_t, name) => (state.missing.has(name) ? undefined : model(name)) }) };
    const db = {
        orm,
        transaction: async (fn) => {
            // snapshot for rollback so tests can assert atomicity
            const snapshot = JSON.stringify(tables, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
            const keep = { ...tables };
            try {
                return await fn({ orm });
            } catch (err) {
                for (const k of Object.keys(tables)) tables[k] = JSON.parse(snapshot)[k].map((r) => ({
                    ...r,
                    secretsEnc: r.secretsEnc && r.secretsEnc.type === "Buffer" ? Buffer.from(r.secretsEnc.data) : r.secretsEnc,
                }));
                void keep;
                throw err;
            }
        },
    };
    return { db, tables, state };
}

export function makeRes() {
    return {
        statusCode: 200,
        body: undefined,
        ended: false,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        end() { this.ended = true; return this; },
    };
}

export const adminReq = (body = {}, params = {}) => ({
    user: { id: "user-1", workspaceId: "ws1", role: "company_admin" },
    body, params, query: {}, ip: "1.2.3.4", headers: { "user-agent": "test" },
});
