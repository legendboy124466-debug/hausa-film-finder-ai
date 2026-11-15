const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadNativeServerSettings() {
    const listeners = {};
    const values = new Map();
    const input = { value: "" };
    const message = { textContent: "", classList: { toggle() {} } };
    const details = { open: false };
    const testButton = {
        disabled: false,
        addEventListener(name, callback) { listeners[`test:${name}`] = callback; }
    };
    const settings = {
        elements: { backendUrl: input },
        addEventListener(name, callback) { listeners[name] = callback; }
    };
    const elements = {
        serverSettingsForm: settings,
        serverSettingsStatus: message,
        serverSettings: details,
        testServerButton: testButton
    };
    const window = {
        Capacitor: { isNativePlatform: () => true },
        location: { protocol: "file:", hostname: "" },
        dispatchEvent() {}
    };
    const requests = [];
    const fetch = async (url) => {
        requests.push(String(url));
        return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, "server-config.js"), "utf8"), {
        window,
        document: { getElementById: (id) => elements[id] || null },
        localStorage: {
            getItem: (key) => values.get(key) || null,
            setItem: (key, value) => values.set(key, value)
        },
        URL,
        fetch,
        CustomEvent: class { constructor(type) { this.type = type; } }
    });
    return { window, input, message, details, listeners, requests };
}

test("native app requires HTTPS, rejects localhost, and uses the configured cloud URL", async () => {
    const native = loadNativeServerSettings();
    assert.equal(native.details.open, true);

    let prevented = false;
    native.input.value = "https://localhost:3000";
    native.listeners.submit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.match(native.message.textContent, /localhost/i);
    assert.equal(native.window.hfServerUrl(), "");

    native.input.value = "https://films.example.invalid";
    native.listeners.submit({ preventDefault() {} });
    assert.equal(native.window.hfServerUrl(), "https://films.example.invalid");
    assert.equal(native.window.hfApiUrl("/api/movies"), "https://films.example.invalid/api/movies");

    await native.listeners["test:click"]();
    assert.deepEqual(native.requests, ["https://films.example.invalid/api/health"]);
    assert.match(native.message.textContent, /haɗu da backend lafiya/i);
});

test("Android manifest requests network, camera, and microphone but not broad media access", () => {
    const manifest = fs.readFileSync(
        path.join(root, "android/app/src/main/AndroidManifest.xml"), "utf8"
    );
    for (const permission of ["INTERNET", "CAMERA", "RECORD_AUDIO"]) {
        assert.match(manifest, new RegExp(`android.permission.${permission}`));
    }
    assert.doesNotMatch(manifest, /READ_MEDIA_(?:IMAGES|VIDEO|AUDIO)/);
});

test("Android web assets retain the phone layout breakpoint", () => {
    const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
    assert.match(css, /@media\s*\(max-width:\s*\d+px\)/);
});

test("Android Admin sessions use encrypted Android Keystore storage with a bounded expiry", () => {
    const plugin = fs.readFileSync(
        path.join(root, "android/app/src/main/java/com/hausafilmfinder/ai/AdminSessionPlugin.java"), "utf8"
    );
    assert.match(plugin, /KeyStore\.getInstance\("AndroidKeyStore"\)/);
    assert.match(plugin, /AES\/GCM\/NoPadding/);
    assert.match(plugin, /setRandomizedEncryptionRequired\(true\)/);
    assert.match(plugin, /MAX_SESSION_MS\s*=\s*15L\s*\*\s*60L\s*\*\s*1000L/);
    assert.match(plugin, /expiresAt\s*<=\s*System\.currentTimeMillis\(\)/);

    const admin = fs.readFileSync(path.join(root, "admin/admin.js"), "utf8");
    assert.match(admin, /registerPlugin\("AdminSession"\)/);
    assert.match(admin, /credentials:\s*nativeAdminSessionPlugin\s*\?\s*"omit"\s*:\s*"include"/);
    assert.match(admin, /Authorization`, `Bearer \$\{token\}`/);
    assert.match(admin, /nativeAdminSessionPlugin\.clearToken\(\)/);
});
