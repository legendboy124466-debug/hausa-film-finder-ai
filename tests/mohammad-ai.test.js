const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hausa-mohammad-tests-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "test.sqlite");
process.env.MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "movies");
process.env.POSTER_UPLOAD_DIR = path.join(temporaryDirectory, "posters");
process.env.MERLIN_UPLOAD_DIR = path.join(temporaryDirectory, "merlin");
process.env.ADMIN_USERNAME = "mohammad-test-admin";
process.env.ADMIN_PASSWORD = "mohammad-test-password-long-enough";
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
const originalLoadEnvFile = process.loadEnvFile;
process.loadEnvFile = () => {};
let createApp;
try {
    ({ createApp } = require("../backend/server"));
} finally {
    process.loadEnvFile = originalLoadEnvFile;
}
const { database } = require("../backend/database");
const {
    getApplicationKnowledge,
    makeSystemPrompt,
    sanitizeHistory
} = require("../backend/mohammad-ai");
const { isPrivateAddress } = require("../backend/local-ai-provider");

let server;
let baseUrl;
let adminCookie;

async function registerUser(phoneNumber) {
    const response = await fetch(`${baseUrl}/api/social/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            phoneNumber,
            fullName: "Mohammad AI Test User",
            password: "mohammad-ai-test-password",
            confirmPassword: "mohammad-ai-test-password"
        })
    });
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie").split(";")[0];
}

before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        })
    });
    assert.equal(login.status, 200);
    adminCookie = login.headers.get("set-cookie").split(";")[0];
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("allows guest access to Mohammad AI and requires admin for owner-Agent APIs", async () => {
    // Mohammad AI endpoints allow guest access
    const mohammadStatus = await fetch(`${baseUrl}/api/mohammad-ai/status`);
    assert.equal(mohammadStatus.status, 200, "/api/mohammad-ai/status should allow guest access");

    const mohammadChat = await fetch(`${baseUrl}/api/mohammad-ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Sannu" })
    });
    assert.equal(mohammadChat.status, 503, "/api/mohammad-ai/chat should return 503 without local AI (not 401)");

    // Owner-Agent APIs still require admin authentication
    const ownerStatus = await fetch(`${baseUrl}/api/admin/owner-agent/status`);
    assert.equal(ownerStatus.status, 401, "/api/admin/owner-agent/status should require auth");

    const ownerTasks = await fetch(`${baseUrl}/api/admin/owner-agent/tasks`);
    assert.equal(ownerTasks.status, 401, "/api/admin/owner-agent/tasks should require auth");

    const userCookie = await registerUser("+234 803 456 7890");
    const forbidden = await fetch(`${baseUrl}/api/admin/owner-agent/status`, {
        headers: { Cookie: userCookie }
    });
    assert.equal(forbidden.status, 401);
});

test("runs only allowlisted read-only owner-Agent tasks and audits them", async () => {
    const denied = await fetch(`${baseUrl}/api/admin/owner-agent/tasks`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "shell", command: "whoami" })
    });
    assert.equal(denied.status, 400);

    const response = await fetch(`${baseUrl}/api/admin/owner-agent/tasks`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "activity-report" })
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.task.status, "completed");
    assert.ok(payload.task.result.authorizedMovies >= 0);
    assert.ok(database.prepare(`
        SELECT 1 FROM owner_agent_audit
        WHERE action = 'owner-agent-task' AND outcome = 'completed'
    `).get());
});

test("shares only authorized movie data and reports unlinked Merlin fingerprints honestly", () => {
    const now = new Date().toISOString();
    database.prepare(`
        INSERT INTO movies (id, title, original_title, hausa_title, description, studio,
            year, permission_confirmed, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("ai-authorized-test", "Test Film", "Original Test Film", "Fim Gwaji",
        "A known test description.", "Test Studio", 2024, 1, now, now);
    database.prepare(`
        INSERT INTO movies (id, title, original_title, studio, permission_confirmed, created_at, updated_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run("ai-private-test", "Private Test Film", "Private Test Film", "Private Studio", now, now);
    try {
        const knowledge = getApplicationKnowledge();
        assert.ok(knowledge.catalogue.movies.some((movie) => movie.title === "Test Film"));
        assert.ok(!knowledge.catalogue.movies.some((movie) => movie.title === "Private Test Film"));
        assert.equal(knowledge.merlinSeason1.episodeCount, 10);
        assert.ok(knowledge.merlinSeason1.episodes.every((episode) =>
            episode.processingStatus === "not-linked-to-processing-jobs" &&
            episode.fingerprintStatus === "not-linked-to-movie-fingerprints"
        ));
        const prompt = makeSystemPrompt(knowledge);
        assert.match(prompt, /Ka yi magana da Hausa/);
        assert.doesNotMatch(prompt, /Private Test Film/);
    } finally {
        database.prepare("DELETE FROM movies WHERE id IN (?, ?)").run(
            "ai-authorized-test", "ai-private-test"
        );
    }
});

test("bounds conversation history and rejects public Ollama URLs", () => {
    const history = sanitizeHistory([
        { role: "system", content: "must not be accepted" },
        ...Array.from({ length: 10 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: "x".repeat(1200)
        }))
    ]);
    assert.equal(history.length, 8);
    assert.ok(history.every((message) => message.content.length === 1000));
    assert.equal(isPrivateAddress("127.0.0.1"), true);
    assert.equal(isPrivateAddress("192.168.1.20"), true);
    assert.equal(isPrivateAddress("example.com"), false);
    assert.equal(isPrivateAddress("8.8.8.8"), false);
});

test("streams a local-model response without sending requests to a paid provider", async () => {
    const previousModel = process.env.MOHAMMAD_AI_MODEL;
    const previousBaseUrl = process.env.MOHAMMAD_AI_BASE_URL;
    const originalFetch = global.fetch;
    process.env.MOHAMMAD_AI_MODEL = "test-local-model";
    process.env.MOHAMMAD_AI_BASE_URL = "http://127.0.0.1:11434";
    const userCookie = await registerUser("+234 804 567 8901");
    const requestedUrls = [];
    global.fetch = async (url, options) => {
        requestedUrls.push(String(url));
        if (url === "http://127.0.0.1:11434/api/tags") {
            return Response.json({ models: [{ name: "test-local-model:latest" }] });
        }
        if (url === "http://127.0.0.1:11434/api/chat") {
            return new Response(
                '{"message":{"content":"Sannu!"}}\n{"message":{"content":" Zan taimaka."}}\n{"done":true}\n',
                { headers: { "Content-Type": "application/x-ndjson" } }
            );
        }
        return originalFetch(url, options);
    };
    try {
        const response = await fetch(`${baseUrl}/api/mohammad-ai/chat`, {
            method: "POST",
            headers: { Cookie: userCookie, "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Ka taimake ni." })
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
        const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(lines.slice(0, 2), [
            { token: "Sannu!" },
            { token: " Zan taimaka." }
        ]);
        assert.deepEqual(lines.at(-1), { done: true });
        const providerRequests = requestedUrls.filter((url) => !url.endsWith("/api/mohammad-ai/chat"));
        assert.equal(providerRequests.length, 2);
        assert.ok(providerRequests.every((url) => url.startsWith("http://127.0.0.1:11434/")));
    } finally {
        global.fetch = originalFetch;
        if (previousModel === undefined) delete process.env.MOHAMMAD_AI_MODEL;
        else process.env.MOHAMMAD_AI_MODEL = previousModel;
        if (previousBaseUrl === undefined) delete process.env.MOHAMMAD_AI_BASE_URL;
        else process.env.MOHAMMAD_AI_BASE_URL = previousBaseUrl;
    }
});

test("reports a missing local model without falling back to an external provider", async () => {
    const previousModel = process.env.MOHAMMAD_AI_MODEL;
    const previousBaseUrl = process.env.MOHAMMAD_AI_BASE_URL;
    const originalFetch = global.fetch;
    process.env.MOHAMMAD_AI_MODEL = "missing-local-model";
    process.env.MOHAMMAD_AI_BASE_URL = "http://127.0.0.1:11434";
    const userCookie = await registerUser("+234 805 678 9012");
    global.fetch = async (url, options) => {
        if (url === "http://127.0.0.1:11434/api/tags") {
            return Response.json({ models: [] });
        }
        return originalFetch(url, options);
    };
    try {
        const status = await fetch(`${baseUrl}/api/mohammad-ai/status`, {
            headers: { Cookie: userCookie }
        });
        assert.equal(status.status, 200);
        assert.equal((await status.json()).modelAvailable, false);

        const chat = await fetch(`${baseUrl}/api/mohammad-ai/chat`, {
            method: "POST",
            headers: { Cookie: userCookie, "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Sannu" })
        });
        assert.equal(chat.status, 503);
        assert.match((await chat.json()).error, /model ɗin da aka zaɓa/);
    } finally {
        global.fetch = originalFetch;
        if (previousModel === undefined) delete process.env.MOHAMMAD_AI_MODEL;
        else process.env.MOHAMMAD_AI_MODEL = previousModel;
        if (previousBaseUrl === undefined) delete process.env.MOHAMMAD_AI_BASE_URL;
        else process.env.MOHAMMAD_AI_BASE_URL = previousBaseUrl;
    }
});
