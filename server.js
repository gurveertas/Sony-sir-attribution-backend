import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { db, closeDatabase } from './src/prisma/db.js';
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
import { adOAuthCallback } from './controllers/workspaceToolsController.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { startWorkers, stopWorkers } from './services/workers.js';
import { jobStats } from './services/jobs.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ── Global middleware ──────────────────────────────────────────────────────
// Preserve the original JSON bytes for webhook signature verification.
app.use(express.json({
    limit: '2mb',
    verify(req, res, buffer) {
        req.rawBody = buffer.toString("utf8");
    },
}));
app.use(cookieParser());

const allowedOrigins = [
    ENV.FRONTEND_URL,
    ...(process.env.EXTRA_CORS_ORIGINS ? process.env.EXTRA_CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean) : []),
    "https://asf-tas.vercel.app",
    "https://asftas.vercel.app",
    "http://localhost:5173",
    ...(ENV.NODE_ENV === "production" ? [] : ["http://localhost:3000", "http://localhost:5173", "http://localhost:5175"]),
];

// Dynamic CORS configuration:
// 1. Server-to-server / curl / webhooks without Origin header are always permitted.
// 2. /v1 (SDK + API), /sdk and /api/connectors allow any origin here; publishable keys enforce
//    their own allowed origins (and verified domains) in apiKeyAuth.
// 3. Dashboard / admin routes strictly require an origin from allowedOrigins.
app.use(cors((req, callback) => {
    const origin = req.header("Origin");
    if (!origin) return callback(null, { origin: true, credentials: true });
    if (req.path.startsWith("/v1") || req.path.startsWith("/api/connectors") || req.path.startsWith("/sdk")) {
        return callback(null, { origin: true, credentials: true });
    }
    if (allowedOrigins.includes(origin)) return callback(null, { origin: true, credentials: true });
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
}));

// The tracking script: cached for an hour, loadable from any site.
app.use('/sdk', (req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
});
app.use(express.static('public'));

// ── Dashboard / Auth / Admin routes (cookie-based auth) ────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/user', userRoutes);
app.use('/api/sites', siteRoutes);
app.use('/api/workspace', workspaceRoutes);
app.use('/api/platform-admin', platformAdminRoutes);
app.use('/api/view', workspaceViewRoutes);
// OAuth redirect from Meta / Google (the signed state identifies the company)
app.get('/api/ad-accounts/oauth/:platform/callback', adOAuthCallback);
app.use('/api', inputFieldRoutes);

// ── Public API (API-key-based auth) ────────────────────────────────────────
app.use('/v1', v1Routes);

// ── Inbound connector webhooks (connector-secret-based auth) ───────────────
app.use('/api/connectors', connectorRoutes);

// ── Health check ───────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    let database = "ok";
    try {
        await db.orm.public.Workspace.where({ id: "00000000-0000-0000-0000-000000000000" }).first();
    } catch {
        database = "unreachable";
    }
    const status = database === "ok" ? 200 : 503;
    res.status(status).json({ status: status === 200 ? "healthy" : "degraded", database, jobs: jobStats(), message: "Attribution Platform API", version: "1.1.0" });
});

app.get('/', (req, res, next) => {
    // If request asks for json or has no html acceptor, return json
    if (!req.accepts('html')) {
        return res.status(200).json({ status: "healthy", message: "Attribution Platform API", version: "1.1.0" });
    }
    next();
});

// ── Centralized Error Handler (must be mounted after all routes) ───────────
app.use(errorHandler);

// ── Server Start & Graceful Shutdown ───────────────────────────────────────
const server = app.listen(ENV.PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${ENV.PORT}`);
});

if (!ENV.DISABLE_BACKGROUND_WORKERS) startWorkers();

const handleShutdown = async (signal) => {
    console.log(`Received ${signal}. Draining connections and shutting down gracefully...`);
    server.close(async () => {
        console.log("HTTP server closed.");
        try {
            await stopWorkers();
            await closeDatabase();
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
