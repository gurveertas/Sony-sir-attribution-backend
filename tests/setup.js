// Minimal env so utils/env.js loads. Imported FIRST by every test file.
process.env.JWT_SECRET ??= "test-jwt-secret";
process.env.DATABASE_PUBLIC_URL ??= "postgres://user:pass@localhost:5432/test";
process.env.PORT ??= "5000";
process.env.RESEND_API_KEY ??= "re_test";
process.env.NODE_ENV ??= "test";
process.env.APP_API_URL = "https://api.example.com";

/** Replace global fetch with a scripted fake. Returns { calls, restore }. */
export function mockFetch(handler) {
    const original = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const call = { url: String(url), method: options.method ?? "GET", headers: options.headers ?? {}, body: options.body };
        calls.push(call);
        const { status = 200, json = {} } = await handler(call);
        return {
            status,
            ok: status >= 200 && status < 300,
            text: async () => (json === null ? "" : JSON.stringify(json)),
        };
    };
    return { calls, restore: () => (globalThis.fetch = original) };
}

export function fakeDeps({ order = null } = {}) {
    const calls = { orders: [], refunds: [], bookings: [] };
    const reply = (list, label) => async (req, res) => {
        list.push(req.body);
        res.status(200).json({ ok: label, externalId: req.body.externalId });
    };
    return {
        calls,
        deps: {
            createOrder: reply(calls.orders, "order"),
            createRefund: reply(calls.refunds, "refund"),
            createBooking: reply(calls.bookings, "booking"),
            findOrder: async () => order,
        },
    };
}
