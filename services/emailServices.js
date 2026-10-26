import nodemailer from "nodemailer";
import ENV from "../utils/env.js";

let transporter;

function getTransporter() {
  if (!ENV.SMTP_USER || !ENV.SMTP_PASS) {
    throw new Error("SMTP_USER and SMTP_PASS must be configured");
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: ENV.SMTP_USER,
        pass: ENV.SMTP_PASS,
      },
    });
  }

  return transporter;
}

export async function sendEmail({ to, subject, html }) {
  try {
    return await getTransporter().sendMail({
      from: ENV.SMTP_USER,
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error("Email delivery failed:", error?.name ?? "error", error?.message ?? "");
    throw new Error("Unable to send email");
  }
}