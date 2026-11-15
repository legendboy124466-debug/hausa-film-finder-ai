(() => {
    const storageKey = "hf-backend-url";
    const settings = document.getElementById("serverSettingsForm");
    const input = settings?.elements.backendUrl;
    const message = document.getElementById("serverSettingsStatus");
    const nativeApp = Boolean(window.Capacitor?.isNativePlatform?.()) ||
        window.location.protocol === "file:" ||
        (window.location.protocol === "https:" && window.location.hostname === "localhost");

    function savedServerUrl() {
        return localStorage.getItem(storageKey) || "";
    }

    function currentServerUrl() {
        const saved = savedServerUrl();
        if (saved) return saved;
        if (!nativeApp && ["http:", "https:"].includes(window.location.protocol)) {
            return window.location.origin;
        }
        return "";
    }

    function apiUrl(path) {
        const value = path instanceof URL
            ? `${path.pathname}${path.search}${path.hash}`
            : String(path);
        if (/^https?:\/\//i.test(value)) return value;
        const base = currentServerUrl();
        if (!base) {
            throw new Error("Saita URL ɗin backend a saitunan haɗin server kafin amfani da wannan fasalin.");
        }
        return new URL(value.replace(/^\/+/, ""), `${base.replace(/\/+$/, "")}/`).href;
    }

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

    function validateServerUrl(value) {
        let url;
        try {
            url = new URL(value.trim());
        } catch {
            throw new Error("Shigar da cikakken URL na backend, misali http://192.168.1.42:3178 ko https://server.example.com.");
        }
        if (!url.hostname || url.username || url.password || url.search || url.hash) {
            throw new Error("URL ɗin ba ya da sunan maka, sunan mai amfani, kalmar sirri, ko ƙarin sigogi ba.");
        }
        const protocol = url.protocol.toLowerCase();
        if (protocol !== "http:" && protocol !== "https:") {
            throw new Error("URL ɗin ya yi amfani da http: ko https:.");
        }
        const hostname = url.hostname.toLowerCase();
        if (hostname === "localhost" || hostname.endsWith(".localhost") ||
            hostname === "127.0.0.1" || hostname === "::1") {
            throw new Error("Kada a yi amfani da localhost: a Android yana nufin wayar kanta. Shigar da URL na backend da wayarka (IP) za ta iya samu.");
        }
        const isHttps = protocol === "https:";
        if (!isHttps && !isPrivateIp(hostname)) {
            throw new Error("HTTP ba a son cika a duk watin: yi amfani da HTTPS don domain, ko http: da IP na waya (LAN) don ƙarfafa makonci.");
        }
        return url.href.replace(/\/+$/, "");
    }

    function showStatus(text, isError = false) {
        if (!message) return;
        message.textContent = text;
        message.classList.toggle("error", isError);
    }

    function refreshSettings() {
        const current = currentServerUrl();
        if (input) input.value = savedServerUrl() || (nativeApp ? "" : current);
        const details = document.getElementById("serverSettings");
        if (nativeApp && !current) {
            details.open = true;
            showStatus("Shigar da HTTPS URL na backend ɗinka don kunna bincike, Merlin, admin da al'umma.");
        } else if (current) {
            showStatus(`An saita backend: ${current}`);
        }
    }

    window.hfApiUrl = apiUrl;
    window.hfServerUrl = currentServerUrl;

    if (!settings || !input || !message) return;

    settings.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const serverUrl = validateServerUrl(input.value);
            localStorage.setItem(storageKey, serverUrl);
            showStatus("An adana URL ɗin backend. Ana sabunta bayanan app…");
            window.dispatchEvent(new CustomEvent("hf:server-config-changed"));
        } catch (error) {
            showStatus(error.message, true);
        }
    });

    const testButton = document.getElementById("testServerButton");
    testButton?.addEventListener("click", async () => {
        testButton.disabled = true;
        try {
            const serverUrl = validateServerUrl(input.value);
            const response = await fetch(
                new URL("api/health", `${serverUrl}/`),
                { credentials: "include" }
            );
            if (!response.ok) throw new Error(`Backend ya dawo da lambar ${response.status}.`);
            const health = await response.json();
            if (health.status !== "ok") throw new Error("Amsar backend ba ta nuna cewa sabis ɗin yana aiki ba.");
            showStatus(`An haɗu da backend lafiya: ${serverUrl}`);
        } catch (error) {
            showStatus(`An kasa gwada backend: ${error.message}`, true);
        } finally {
            testButton.disabled = false;
        }
    });

    refreshSettings();
})();
