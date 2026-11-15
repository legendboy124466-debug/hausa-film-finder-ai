const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createAdminSessionStore } = require("../backend/admin-sessions");

test("native admin sessions have random tokens, expire, and can be revoked", () => {
    let now = 10_000;
    const store = createAdminSessionStore({ ttlMs: 900_000, now: () => now });
    const issued = store.issue("admin");
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.expiresAt, now + 900_000);
    assert.equal(store.verify(issued.token).username, "admin");

    now = issued.expiresAt;
    assert.equal(store.verify(issued.token), null);

    now = 20_000;
    const second = store.issue("admin");
    assert.equal(store.revoke(second.token), true);
    assert.equal(store.verify(second.token), null);
    assert.equal(store.verify("not-a-session"), null);
});
