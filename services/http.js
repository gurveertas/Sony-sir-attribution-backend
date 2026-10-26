/**
 * Small HTTP helpers shared by controllers:
 *   - one error format everywhere: { message, code }  (scope 4.3 "consistent error format")
 *   - CSV export for every report/list (scope 5: "Every screen has an Export (CSV) action")
 *   - page or cursor pagination over an already-sorted array
 */

const CODE_BY_STATUS = { 400: "validation_error", 401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict", 422: "validation_error", 429: "rate_limited", 503: "unavailable" };

export function sendError(res, error, label = "request") {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) {
        console.error(`${label} error:`, error?.message ?? error);
        return res.status(500).json({ message: "Internal server error", code: "internal_error" });
    }
    return res.status(status).json({ message: error.message, code: error.code || CODE_BY_STATUS[status] || "error" });
}

const csvCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // neutralise spreadsheet formulas (CSV injection) and quote when needed
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** columns: [{ key, label }] or string keys; rows: plain objects (nested via "a.b"). */
export function toCsv(rows, columns) {
    const cols = columns.map((c) => (typeof c === "string" ? { key: c, label: c } : c));
    const get = (row, key) => key.split(".").reduce((v, k) => (v == null ? v : v[k]), row);
    const lines = [cols.map((c) => csvCell(c.label)).join(",")];
    for (const row of rows) lines.push(cols.map((c) => csvCell(typeof c.value === "function" ? c.value(row) : get(row, c.key))).join(","));
    return lines.join("\r\n") + "\r\n";
}

export const wantsCsv = (req) => String(req.query?.format ?? "").toLowerCase() === "csv" || String(req.headers?.accept ?? "").includes("text/csv");

export function sendCsv(res, filename, rows, columns) {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    return res.status(200).send(toCsv(rows, columns));
}

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const dec = (s) => {
    try {
        return JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
    } catch {
        return null;
    }
};

/**
 * Paginate an array already sorted by (sortKey desc, id desc).
 * ?cursor=<opaque> (preferred, stable while new rows arrive) or ?page=N; ?limit (1..100, default 25).
 */
export function paginate(rows, req, sortKey) {
    const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));
    if (req.query?.cursor) {
        const c = dec(req.query.cursor);
        let start = 0;
        if (c) {
            const idx = rows.findIndex((r) => {
                const v = String(r[sortKey] ?? "");
                return v < c.v || (v === c.v && String(r.id) < c.id);
            });
            start = idx === -1 ? rows.length : idx;
        }
        const data = rows.slice(start, start + limit);
        const last = data[data.length - 1];
        const hasMore = start + limit < rows.length;
        return {
            data,
            pagination: { limit, total: rows.length, nextCursor: hasMore && last ? enc({ v: String(last[sortKey] ?? ""), id: String(last.id) }) : null },
        };
    }
    const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
    const data = rows.slice((page - 1) * limit, page * limit);
    const last = data[data.length - 1];
    return {
        data,
        pagination: {
            page,
            limit,
            total: rows.length,
            pages: Math.ceil(rows.length / limit),
            nextCursor: page * limit < rows.length && last ? enc({ v: String(last[sortKey] ?? ""), id: String(last.id) }) : null,
        },
    };
}

export const sortDesc = (rows, key) =>
    rows.sort((a, b) => String(b[key] ?? "").localeCompare(String(a[key] ?? "")) || String(b.id).localeCompare(String(a.id)));
