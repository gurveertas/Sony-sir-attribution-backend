/**
 * Password policy (scope 4.10): one rule used by sign-up, invites, member creation and password reset.
 *   - 10 to 200 characters
 *   - at least one letter and one digit
 *   - must not contain the account's email address
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** @returns {string|null} an error message, or null when the password is acceptable */
export function passwordProblem(password, email = "") {
    if (typeof password !== "string") return "Password is required";
    if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters long`;
    if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters long`;
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Password must contain at least one letter and one number";
    const local = String(email || "").trim().toLowerCase().split("@")[0];
    if (local && local.length >= 4 && password.toLowerCase().includes(local)) return "Password must not contain your email address";
    return null;
}
