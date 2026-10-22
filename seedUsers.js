// scripts/seedUsers.js
// Creates one user per role: platform_admin, company_admin, company_viewer.
// Safe to re-run: existing emails are skipped.
// Run:  SEED_PASSWORD='your-strong-password' node scripts/seedUsers.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "./src/prisma/db.js";

const password = process.env.SEED_PASSWORD || crypto.randomBytes(9).toString("base64url");
const generated = !process.env.SEED_PASSWORD;

const USERS = [
  { role: "platform_admin", name: "Platform Admin", email: "platform.admin@example.com", inWorkspace: false },
  { role: "company_admin", name: "Company Admin", email: "company.admin@example.com", inWorkspace: true },
  { role: "company_viewer", name: "Company Viewer", email: "company.viewer@example.com", inWorkspace: true },
];

async function main() {
  const passwordHash = await bcrypt.hash(password, 10);

  // Workspace for the two company users (platform admin has none)
  const slug = "demo-company";
  let workspace = await db.orm.public.Workspace.where({ slug }).first();
  if (!workspace) {
    workspace = await db.orm.public.Workspace.create({
      name: "Demo Company",
      slug,
      country: "IN",
      dataRegion: "in",
      timezone: "Asia/Kolkata",
      reportingCurrency: "INR",
      status: "active",
    });
    console.log("created workspace:", workspace.id);
  }

  for (const u of USERS) {
    const exists = await db.orm.public.User.where({ email: u.email }).first();
    if (exists) {
      console.log("skipped (exists):", u.email);
      continue;
    }
    await db.orm.public.User.create({
      workspaceId: u.inWorkspace ? workspace.id : null,
      email: u.email,
      name: u.name,
      passwordHash,
      role: u.role,
      status: "active",
      emailVerifiedAt: new Date().toISOString(),
    });
    console.log("created:", u.role, u.email);
  }

  if (generated) console.log("\nGenerated password (shown once):", password);
}

main()
  .catch((err) => {
    console.error("seed failed:", err.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());