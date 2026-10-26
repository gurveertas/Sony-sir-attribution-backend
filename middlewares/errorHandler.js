/**
 * Global Error Handler Middleware
 *
 * Catches unhandled errors from any route/middleware and returns
 * a consistent error response. In development, includes the stack trace.
 *
 * Mount this AFTER all routes in server.js:
 *   app.use(errorHandler);
 */

import ENV from "../utils/env.js";

export function errorHandler(err, req, res, _next) {
    // Log the error (method + path only: never request bodies or personal data)
    console.error(`[ERROR] ${req.method} ${String(req.originalUrl ?? "").split("?")[0]}:`, err.message);
    if (ENV.NODE_ENV === "development") {
        console.error(err.stack);
    }

    // Prisma unique constraint violation
    if (err.code === "23505") {
        return res.status(409).json({
            message: "A record with this value already exists",
            code: "conflict",
        });
    }

    // Prisma foreign key violation
    if (err.code === "23503") {
        return res.status(400).json({
            message: "Referenced record does not exist",
            code: "validation_error",
        });
    }

    // JSON parse error
    if (err.type === "entity.parse.failed") {
        return res.status(400).json({
            message: "Invalid JSON in request body",
            code: "invalid_json",
        });
    }

    // Default
    const statusCode = err.statusCode || err.status || 500;
    const response = {
        message: statusCode >= 500 ? "Internal server error" : err.message,
        code: err.code && typeof err.code === "string" && !/^\d+$/.test(err.code) ? err.code : statusCode >= 500 ? "internal_error" : "error",
    };

    return res.status(statusCode).json(response);
}
