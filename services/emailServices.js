import nodemailer from "nodemailer";
import ENV from "../utils/env.js";

let transporter;

function getTransporter() {
  if ((ENV.SMTP_USER && !ENV.SMTP_PASS) || (!ENV.SMTP_USER && ENV.SMTP_PASS)) {
    throw new Error("SMTP_USER and SMTP_PASS must both be configured");
  }
  if (!Number.isInteger(ENV.SMTP_PORT) || ENV.SMTP_PORT < 1 || ENV.SMTP_PORT > 65535) {
    throw new Error("SMTP_PORT must be a valid port number");
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "me@gmail.com",
      pass: process.env.GOOGLE_APP_PASSWORD, // The 16-character App Password
    },
  });

  return transporter;
}

export async function sendEmail({ to, subject, html }) {
  try {
    return await getTransporter().sendMail({
      from: ENV.EMAIL_FROM,
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error("Email delivery failed:", error?.name ?? "error", error?.message ?? "");
    throw new Error("Unable to send email");
  }
}