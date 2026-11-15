const appOrigins = new Set(["https://localhost"]);

function isPrivateIp(hostname) {
    const parts = hostname.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
        const a = Number(parts[0]);
        const b = Number(parts[1]);
        return a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168);
    }
    return false;
}

for (const configuredOrigin of (process.env.CAPACITOR_APP_ORIGINS || "").split(",")) {
    const value = configuredOrigin.trim();
    if (!value) continue;
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`CAPACITOR_APP_ORIGINS contains an invalid URL: ${value}`);
    }
    if (parsed.origin !== value) {
        throw new Error(`CAPACITOR_APP_ORIGINS must contain origins without paths: ${value}`);
    }
    const isHttps = parsed.protocol === "https:";
    if (!isHttps && !isPrivateIp(parsed.hostname)) {
        throw new Error(`CAPACITOR_APP_ORIGINS HTTP origins are only allowed for private LAN IP addresses: ${value}`);
    }
    appOrigins.add(parsed.origin);
}

function isTrustedOrigin(origin, host) {
    if (!origin) return false;
    try {
        const parsed = new URL(origin);
        return parsed.host === host || appOrigins.has(parsed.origin);
    } catch {
        return false;
    }
}

function isCrossSiteAppRequest(request) {
    const origin = request.get("origin");
    if (!origin || !appOrigins.has(origin)) return false;
    return new URL(origin).host !== request.get("host");
}

module.exports = { appOrigins, isTrustedOrigin, isCrossSiteAppRequest };
