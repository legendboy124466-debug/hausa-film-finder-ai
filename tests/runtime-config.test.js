const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    loadFileSecrets,
    configureProxyTrust,
    validateProductionAdminSecrets
} = require("../backend/runtime-config");

test("loads file-backed Admin secrets without changing their content or logging them", (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hf-secrets-test-"));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const passwordPath = path.join(directory, "password");
    fs.writeFileSync(passwordPath, " private test value \r\n");
    const environment = {
        ADMIN_PASSWORD: "",
        ADMIN_PASSWORD_FILE: passwordPath
    };

    loadFileSecrets(environment);

    assert.equal(environment.ADMIN_PASSWORD, " private test value ");
    assert.equal(environment.ADMIN_PASSWORD_FILE, passwordPath);
});

test("keeps existing environment credentials when no secret file is configured", () => {
    const environment = { ADMIN_USERNAME: "configured-user" };
    loadFileSecrets(environment);
    assert.equal(environment.ADMIN_USERNAME, "configured-user");
});

test("trusts only explicitly configured proxy settings", () => {
    const calls = [];
    const app = { set: (...args) => calls.push(args) };

    configureProxyTrust(app, { TRUST_PROXY: "loopback" });
    configureProxyTrust(app, { TRUST_PROXY: "10.254.240.2" });
    configureProxyTrust(app, { TRUST_PROXY: "1" });

    assert.deepEqual(calls, [
        ["trust proxy", "loopback"],
        ["trust proxy", "10.254.240.2"],
        ["trust proxy", 1]
    ]);

    assert.throws(
        () => configureProxyTrust(app, { TRUST_PROXY: "true" }),
        /only accepts 'loopback', a positive proxy hop count, or one exact proxy IP address/
    );

    assert.throws(
        () => configureProxyTrust(app, { TRUST_PROXY: "0" }),
        /only accepts 'loopback', a positive proxy hop count, or one exact proxy IP address/
    );
});

test("requires strong Admin secrets before production server startup", () => {
    assert.throws(
        () => validateProductionAdminSecrets({ NODE_ENV: "production" }),
        /Production requires Admin credentials/
    );
    assert.doesNotThrow(() => validateProductionAdminSecrets({
        NODE_ENV: "production",
        ADMIN_USERNAME: "owner",
        ADMIN_PASSWORD: "a private password of sufficient length",
        SESSION_SECRET: "s".repeat(32)
    }));
    assert.doesNotThrow(() => validateProductionAdminSecrets({ NODE_ENV: "test" }));
});