const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const usersPath = path.join(root, "data", "users.json");

// Minimum password length requirement
const MIN_PASSWORD_LENGTH = 12;

// Maximum password length (security best practice)
const MAX_PASSWORD_LENGTH = 128;

// Maximum age for a session (30 minutes)
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// In-memory user sessions (short-lived for rate limiting)
const userSessions = new Map();
const sessionTimers = new Map();

function loadUsers() {
  if (!fs.existsSync(usersPath)) {
    const defaultUsers = {
      admin: {
        id: "admin",
        username: "admin",
        passwordHash: scryptHash("adminhausafilmsfinderai1133"),
        role: "admin",
        createdAt: new Date().toISOString(),
      },
    };
    fs.mkdirSync(path.dirname(usersPath), { recursive: true });
    fs.writeFileSync(usersPath, JSON.stringify(defaultUsers, null, 2));
    return defaultUsers;
  }
  try {
    return JSON.parse(fs.readFileSync(usersPath, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.mkdirSync(path.dirname(usersPath), { recursive: true });
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}

/**
 * Hash a password using scrypt (secure, memory-hard function)
 * @param {string} password - Plaintext password
 * @returns {string} - Scrypt hash in format: 'salt:hash'
 */
function scryptHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(password, salt, 32);
  return `${salt}:${key.toString("hex")}`;
}

/**
 * Verify a password against a scrypt hash
 * @param {string} password - Plaintext password to check
 * @param {string} hash - stored hash in 'salt:hash' format
 * @returns {boolean} - true if password matches
 */
function verifyScryptHash(password, hash) {
  try {
    const [salt, storedHash] = hash.split(":");
    if (!salt || !storedHash) return false;
    const key = crypto.scryptSync(password, salt, 32);
    return key.toString("hex") === storedHash;
  } catch {
    return false;
  }
}

/**
 * Validate password strength
 * @param {string} password - Password to validate
 * @returns {object} - { valid: boolean, reason?: string }
 */
function validatePasswordStrength(password) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long (you provided ${password.length})`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      valid: false,
      reason: `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`,
    };
  }
  // Check for at least one number, one letter
  if (!/(?=\\D*\\d)[0-9]/.test(password)) {
    return { valid: false, reason: "Password should contain at least one number" };
  }
  if (!/(?=.*[a-zA-Z])./.test(password)) {
    return { valid: false, reason: "Password should contain at least one letter" };
  }
  return { valid: true };
}