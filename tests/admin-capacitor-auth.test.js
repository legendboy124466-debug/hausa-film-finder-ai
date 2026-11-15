const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hf-native-admin-auth-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "test.sqlite");
process.env.MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "movies");
process.env.POSTER_UPLOAD_DIR = path.join(temporaryDirectory, "posters");
process.env.MERLIN_UPLOAD_DIR = path.join(temporaryDirectory, "merlin");
process.env.ADMIN_USERNAME = "native-test-admin";
process.env.ADMIN_PASSWORD = "test-only-admin-password-long-enough";
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
process.env.CAPACITOR_APP_ORIGINS = "https://localhost";

const originalLoadEnvFile = process.loadEnvFile;
process.loadEnvFile = () => {};
let createApp;
try {
    ({ createApp } = require("../backend/server"));
} finally {
    process.loadEnvFile = originalLoadEnvFile;
}
const { database } = require("../backend/database");
const { createAdminSessionStore, DEFAULT_TTL_MS } = require("../backend/admin-sessions");

let server;
let baseUrl;

before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("Capacitor login receives a short-lived token instead of a cross-site cookie", async () => {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { Origin: "https://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
    assert.equal(response.headers.get("set-cookie"), null);
    const payload = await response.json();
    assert.equal(payload.authenticated, true);
    assert.match(payload.accessToken, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(payload.expiresAt > Date.now());
    assert.ok(payload.expiresAt <= Date.now() + DEFAULT_TTL_MS + 1000);
});

test("stored native session can authenticate later requests and logout revokes it", async () => {
    const login = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { Origin: "https://localhost", "Content-Type": "application/json" },
        body: JSON.stringify({
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        })
    });
    const issued = await login.json();

    // This models the token returned from Android Keystore-backed storage after a UI reload.
    const secureStorageAfterReload = { token: issued.accessToken, expiresAt: issued.expiresAt };
    const authHeaders = {
        Origin: "https://localhost",
        Authorization: `Bearer ${secureStorageAfterReload.token}`
    };
    const session = await fetch(`${baseUrl}/api/admin/me`, { headers: authHeaders });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).username, process.env.ADMIN_USERNAME);

    const dashboard = await fetch(`${baseUrl}/api/admin/jobs`, { headers: authHeaders });
    assert.equal(dashboard.status, 200);

    const preflight = await fetch(`${baseUrl}/api/admin/logout`, {
        method: "OPTIONS",
        headers: {
            Origin: "https://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization"
        }
    });
    assert.equal(preflight.status, 204);

    const logout = await fetch(`${baseUrl}/api/admin/logout`, {
        method: "POST",
        headers: authHeaders
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { authenticated: false });
    const revoked = await fetch(`${baseUrl}/api/admin/me`, { headers: authHeaders });
    assert.equal(revoked.status, 401);
});

test("native tokens expire and cannot be reused after revocation", () => {
    let now = 1000;
    const store = createAdminSessionStore({ ttlMs: 100, now: () => now });
    const issued = store.issue("admin");
    assert.equal(store.verify(issued.token).username, "admin");
    now = issued.expiresAt;
    assert.equal(store.verify(issued.token), null);

    const second = store.issue("admin");
    assert.equal(store.revoke(second.token), true);
    assert.equal(store.verify(second.token), null);
});

test("Android stores the native token encrypted with Android Keystore and does not enable global third-party cookies", () => {
    const plugin = fs.readFileSync(path.join(__dirname, "../android/app/src/main/java/com/hausafilmfinder/ai/AdminSessionPlugin.java"), "utf8");
    const activity = fs.readFileSync(path.join(__dirname, "../android/app/src/main/java/com/hausafilmfinder/ai/MainActivity.java"), "utf8");
    const admin = fs.readFileSync(path.join(__dirname, "../admin/admin.js"), "utf8");
    assert.match(plugin, /AndroidKeyStore/);
    assert.match(plugin, /AES\/GCM\/NoPadding/);
    assert.match(plugin, /getSharedPreferences/);
    assert.match(plugin, /commit\(\)/);
    assert.match(plugin, /clearToken/);
    assert.match(activity, /registerPlugin\(AdminSessionPlugin\.class\)/);
    assert.doesNotMatch(activity + plugin, /setAcceptThirdPartyCookies/);
    assert.match(admin, /credentials: nativeAdminSessionPlugin \? "omit" : "include"/);
    assert.match(admin, /Authorization.*Bearer/);
    assert.doesNotMatch(admin, /localStorage\.(?:getItem|setItem).*token/i);
});
