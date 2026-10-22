import { Resend } from "resend";
import ENV from "../utils/env.js";

const resend = new Resend(ENV.RESEND_API_KEY);

export async function sendEmail({ to, subject, html }) {
  const { data, error } = await resend.emails.send({
    from: ENV.EMAIL_FROM,
    to: [to],
    subject,
    html,
  });

  if (error) {
    console.error("Email delivery request failed:", error);
    throw new Error("Unable to send email");
  }

  return data;
}