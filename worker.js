import { closeDatabase } from "./src/prisma/db.js";
import { startWorkers, stopWorkers } from "./services/workers.js";

startWorkers();

const keepAlive = setInterval(() => {}, 60_000);

async function shutdown(signal) {
    console.log(`Received ${signal}; stopping background workers...`);
    clearInterval(keepAlive);
    try {
        await stopWorkers();
        await closeDatabase();
        process.exit(0);
    } catch (error) {
        console.error("Error stopping background workers:", error?.message ?? error);
        process.exit(1);
    }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
