import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { db } from './src/prisma/db.js';
import ENV from './utils/env.js';

// ── Route imports ──────────────────────────────────────────────────────────
import authRoutes from './routes/authRoutes.js';
import apiKeyRoutes from './routes/apiKeyRoutes.js';
import userRoutes from './routes/userRoutes.js';
import siteRoutes from './routes/siteRoutes.js';
import workspaceViewRoutes from './routes/workspaceViewRoutes.js';
import workspaceRoutes from './routes/workspaceRoutes.js';
import platformAdminRoutes from './routes/platformAdminRoutes.js';
import v1Routes from './routes/v1Routes.js';
import inputFieldRoutes from './routes/inputFieldsRoutes.js';
import connectorRoutes from './routes/connectorRoutes.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();
app.set('trust proxy', 1);

// ── Global middleware ──────────────────────────────────────────────────────
// Preserve the original JSON bytes for webhook signature verification.
app.use(express.json({
    verify(req, res, buffer) {
        req.rawBody = buffer.toString("utf8");
    },
}));
app.use(cookieParser());

const allowedOrigins = [
    "https://asf-tas.vercel.app",
    "https://asftas.vercel.app",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5175",
];

// Dynamic CORS configuration:
// 1. Server-to-server / curl / webhooks without Origin header are always permitted.
// 2. /v1 (SDK tracking) and /api/connectors (inbound webhooks) allow browser / webhook origins;
//    publishable keys enforce exact site domain match in apiKeyAuth.
// 3. Admin / Dashboard / User API routes strictly require an origin from allowedOrigins.
app.use(cors((req, callback) => {
    const origin = req.header("Origin");

    if (!origin) {
        return callback(null, { origin: true, credentials: true });
    }

    if (req.path.startsWith("/v1") || req.path.startsWith("/api/connectors")) {
        return callback(null, { origin: true, credentials: true });
    }

    if (allowedOrigins.includes(origin)) {
        return callback(null, { origin: true, credentials: true });
    }

    return callback(new Error(`Origin ${origin} not allowed by CORS`));
}));

app.use(express.static('public'));

// ── Dashboard / Auth / Admin routes (cookie-based auth) ────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/user', userRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/platform-admin', platformAdminRoutes);
app.use('/api/view', workspaceViewRoutes);
app.use('/api', inputFieldRoutes);

// ── Public API (API-key-based auth) ────────────────────────────────────────
app.use('/v1', v1Routes);

// ── Inbound connector webhooks (connector-secret-based auth) ───────────────
app.use('/api/connectors', connectorRoutes);

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "healthy", message: "Attribution Platform API", version: "1.0.0" });
});

app.get('/', (req, res, next) => {
    // If request asks for json or has no html acceptor, return json
    if (!req.accepts('html')) {
        return res.status(200).json({ status: "healthy", message: "Attribution Platform API", version: "1.0.0" });
    }
    next();
});

// ── Centralized Error Handler (must be mounted after all routes) ───────────
app.use(errorHandler);

// ── Server Start & Graceful Shutdown ───────────────────────────────────────
const server = app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${ENV.PORT}`);
});

const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Draining connections and shutting down gracefully...`);
    server.close(async () => {
        console.log("HTTP server closed.");
        try {
            await db.close();
            console.log("Database connection pool closed successfully.");
        } catch (dbErr) {
            console.error("Error closing database pool:", dbErr.message);
        }
        process.exit(0);
    });

    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => {
        console.error("Forcefully terminating process after 10s timeout.");
        process.exit(1);
    }, 10000).unref();
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
