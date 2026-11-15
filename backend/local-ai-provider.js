const net = require("node:net");

const defaultBaseUrl = "http://127.0.0.1:11434";
const maximumModelNameLength = 120;

function isPrivateAddress(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    const family = net.isIP(host);
    if (family === 4) {
        const [first, second] = host.split(".").map(Number);
        return first === 10 ||
            first === 127 ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168) ||
            (first === 169 && second === 254);
    }
    if (family === 6) {
        return host === "::1" ||
            host.startsWith("fc") ||
            host.startsWith("fd") ||
            /^fe[89ab]/.test(host);
    }
    return false;
}

function getProviderConfiguration() {
    const model = process.env.MOHAMMAD_AI_MODEL?.trim() || "";
    if (model.length > maximumModelNameLength || /[\r\n]/.test(model)) {
        return { configured: false, error: "model" };
    }

    let url;
    try {
        url = new URL(process.env.MOHAMMAD_AI_BASE_URL?.trim() || defaultBaseUrl);
    } catch {
        return { configured: false, error: "url" };
    }
    if (!["http:", "https:"].includes(url.protocol) ||
        !isPrivateAddress(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
        return { configured: false, error: "url" };
    }

    return {
        configured: Boolean(model),
        model,
        baseUrl: url.href.replace(/\/+$/, ""),
        error: model ? null : "model"
    };
}

async function checkLocalModel() {
    const configuration = getProviderConfiguration();
    if (!configuration.configured) {
        return {
            configured: false,
            runtimeAvailable: false,
            modelAvailable: false,
            error: configuration.error
        };
    }
    try {
        const response = await fetch(`${configuration.baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(1500)
        });
        if (!response.ok) {
            return { configured: true, runtimeAvailable: false, modelAvailable: false };
        }
        const payload = await response.json();
        const models = Array.isArray(payload.models) ? payload.models : [];
        return {
            configured: true,
            runtimeAvailable: true,
            modelAvailable: models.some((item) =>
                item.name === configuration.model ||
                item.name?.split(":")[0] === configuration.model.split(":")[0]
            )
        };
    } catch {
        return { configured: true, runtimeAvailable: false, modelAvailable: false };
    }
}

async function streamLocalChat({ messages, onToken, signal }) {
    const configuration = getProviderConfiguration();
    if (!configuration.configured) {
        throw new Error(configuration.error === "url" ? "invalid-provider-url" : "model-not-configured");
    }

    const response = await fetch(`${configuration.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: configuration.model,
            messages,
            stream: true,
            options: { num_ctx: 2048, num_predict: 256 },
            keep_alive: "5m"
        }),
        signal
    });
    if (!response.ok || !response.body) throw new Error("local-model-unavailable");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop() || "";
            for (const line of lines) {
                if (!line.trim()) continue;
                let chunk;
                try {
                    chunk = JSON.parse(line);
                } catch {
                    throw new Error("invalid-local-model-stream");
                }
                if (chunk.error) throw new Error("local-model-stream-error");
                const token = chunk.message?.content;
                if (typeof token === "string" && token) onToken(token);
            }
        }
        pending += decoder.decode();
        if (pending.trim()) {
            let chunk;
            try {
                chunk = JSON.parse(pending);
            } catch {
                throw new Error("invalid-local-model-stream");
            }
            if (chunk.error) throw new Error("local-model-stream-error");
            const token = chunk.message?.content;
            if (typeof token === "string" && token) onToken(token);
        }
    } finally {
        reader.releaseLock();
    }
}

module.exports = {
    checkLocalModel,
    getProviderConfiguration,
    isPrivateAddress,
    streamLocalChat
};
