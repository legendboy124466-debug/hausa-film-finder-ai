const fs = require("node:fs");
const net = require("node:net");

const fileBackedSecrets = ["ADMIN_USERNAME", "ADMIN_PASSWORD", "SESSION_SECRET"];

function loadFileSecrets(environment = process.env) {
    for (const name of fileBackedSecrets) {
        const filePath = environment[`${name}_FILE`];
        if (typeof filePath !== "string" || !filePath.trim()) continue;
        const secret = fs.readFileSync(filePath, "utf8").replace(/(?:\r?\n)+$/, "");
        environment[name] = secret;
    }
}

function configureProxyTrust(app, environment = process.env) {
    const proxySetting = typeof environment.TRUST_PROXY === "string"
        ? environment.TRUST_PROXY.trim().toLowerCase()
        : "";
    if (!proxySetting) return;

    if (proxySetting === "loopback" || net.isIP(proxySetting) !== 0) {
        app.set("trust proxy", proxySetting);
        return;
    }

    if (/^[1-9]\d*$/.test(proxySetting)) {
        app.set("trust proxy", Number(proxySetting));
        return;
    }

    throw new Error("TRUST_PROXY only accepts 'loopback', a positive proxy hop count, or one exact proxy IP address.");
}

function validateProductionAdminSecrets(environment = process.env) {
    if (environment.NODE_ENV !== "production") return;
    if (!environment.ADMIN_USERNAME ||
        typeof environment.ADMIN_PASSWORD !== "string" || environment.ADMIN_PASSWORD.length < 12 ||
        typeof environment.SESSION_SECRET !== "string" || environment.SESSION_SECRET.length < 32) {
        throw new Error("Production requires Admin credentials and a SESSION_SECRET of at least 32 characters.");
    }
}

module.exports = { loadFileSecrets, configureProxyTrust, validateProductionAdminSecrets };