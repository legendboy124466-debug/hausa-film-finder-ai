const crypto = require("node:crypto");

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function tokenDigest(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function createAdminSessionStore({ ttlMs = DEFAULT_TTL_MS, now = Date.now, createToken } = {}) {
    const sessions = new Map();
    const makeToken = createToken || (() => crypto.randomBytes(32).toString("base64url"));

    function discardExpired(currentTime = now()) {
        for (const [digest, session] of sessions) {
            if (session.expiresAt <= currentTime) sessions.delete(digest);
        }
    }

    return {
        issue(username) {
            if (typeof username !== "string" || !username ||
                !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
                throw new TypeError("Admin session parameters are invalid.");
            }
            discardExpired();
            const token = makeToken();
            if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
                throw new TypeError("Admin session token generation failed.");
            }
            const expiresAt = now() + ttlMs;
            sessions.set(tokenDigest(token), { username, expiresAt });
            return { token, expiresAt };
        },

        verify(token) {
            if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
            const digest = tokenDigest(token);
            const session = sessions.get(digest);
            if (!session) return null;
            if (session.expiresAt <= now()) {
                sessions.delete(digest);
                return null;
            }
            return { ...session };
        },

        revoke(token) {
            if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
            return sessions.delete(tokenDigest(token));
        },

        clearExpired() {
            discardExpired();
        }
    };
}

module.exports = { createAdminSessionStore, DEFAULT_TTL_MS };
