const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hausa-merlin-upload-test-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "merlin-test.sqlite");
process.env.MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "movies");
process.env.MERLIN_MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "movies", "merlin");
process.env.MERLIN_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "legacy-merlin");
process.env.POSTER_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "posters");
process.env.ADMIN_USERNAME = "merlin-test-admin";
process.env.ADMIN_PASSWORD = "merlin-test-password-long-enough";
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
const parseMerlinEpisodeNumber = require("../admin/merlin-episode");

test("detects Merlin episode numbers 1–10 from common Hausa and English filenames", () => {
    const examples = [
        ["Merlin Season 1 Episode 01.mp4", 1],
        ["Marlin Fita Ta 1 algaita dub studio.avi", 1],
        ["Merlin Episode 1.avi", 1],
        ["Merlin S01E01.mp4", 1],
        ["Marlin season 1 epison 9 algaita dub studio.avi", 9],
        ["Marlin season 1 epison 10 algaita dub studio.avi", 10],
        ["Marlin season 1epison 2Algaita.avi", 2],
        ["Marlin season 1epison 3 algaita dub studio.avi", 3],
        ["Marlin season 1epison 4 algaita dub studio.avi", 4],
        ["Marlin season 1epison 5 algaita dub studio.mp4", 5],
        ["Marlin season 1epison 6 algaita dub studio.mp4", 6],
        ["Marlin season 1epison 7 algaita dub studio.avi", 7],
        ["Marlin season 1epison 8 algaita dub studio.avi", 8],
        ["Merlin Episode 10.mp4", 10]
    ];
    for (const [filename, expected] of examples) {
        assert.equal(parseMerlinEpisodeNumber(filename), expected, filename);
    }
    assert.equal(parseMerlinEpisodeNumber("Merlin Episode 11.mp4"), null);
    assert.equal(parseMerlinEpisodeNumber("Marlin Season 1 Algaita dub studio.avi"), null);
    assert.equal(parseMerlinEpisodeNumber("Unknown video 1.avi"), null);
});

const sampleVideoPath = path.join(temporaryDirectory, "Merlin Season 1 Episode 01.mp4");
let server;
let baseUrl;
let adminCookie;

before(async () => {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=5",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
        "-t", "12", "-threads", "1",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k", "-shortest", sampleVideoPath
    ], { windowsHide: true, timeout: 120000 });

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

async function uploadAuthorizedEpisode() {
    const form = new FormData();
    form.set("episodeNumber", "1");
    form.set("seasonNumber", "1");
    form.set("studio", "Authorized Synthetic Test Studio");
    form.set("year", "2009");
    form.set("language", "Hausa");
    form.set("actors", "Jarumi Na Farko, Jarumi Na Biyu");
    form.set("permissionConfirmed", "true");
    form.set("movie", new Blob([fs.readFileSync(sampleVideoPath)], { type: "video/mp4" }), path.basename(sampleVideoPath));
    return fetch(`${baseUrl}/api/admin/merlin-movies`, {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: form
    });
}

test("uploads one authorized synthetic episode, queues it, and saves genuine fingerprints", async () => {
    const page = await fetch(`${baseUrl}/admin`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /SELECT MOVIES/);
    assert.match(html, /id="merlinMovieFiles"[^>]*multiple/);

    const response = await uploadAuthorizedEpisode();
    const uploaded = await response.json();
    assert.equal(response.status, 202, JSON.stringify(uploaded));
    assert.equal(uploaded.uploadStatus, "completed");
    assert.equal(uploaded.fingerprintStatus, "waiting");
    assert.equal(uploaded.episodeNumber, 1);
    assert.match(uploaded.title, /Merlin Season 01 Episode 01/);

    const movie = database.prepare(`
        SELECT id, title, movie_path, permission_confirmed, studio, year, language, actors_json
        FROM movies WHERE id = ?
    `).get(uploaded.movieId);
    assert.ok(movie);
    assert.equal(movie.permission_confirmed, 1);
    assert.equal(movie.studio, "Authorized Synthetic Test Studio");
    assert.equal(movie.year, 2009);
    assert.equal(movie.language, "Hausa");
    assert.deepEqual(JSON.parse(movie.actors_json), ["Jarumi Na Farko", "Jarumi Na Biyu"]);
    assert.equal(path.dirname(movie.movie_path), process.env.MERLIN_MOVIE_UPLOAD_DIR);
    assert.ok(fs.existsSync(movie.movie_path));

    const registered = database.prepare(`
        SELECT season_number, episode_number, sha256
        FROM merlin_movie_uploads WHERE movie_id = ?
    `).get(movie.id);
    assert.deepEqual(
        { season: registered.season_number, episode: registered.episode_number },
        { season: 1, episode: 1 }
    );
    assert.match(registered.sha256, /^[a-f0-9]{64}$/);
    assert.equal(database.prepare("SELECT movie_id FROM processing_jobs WHERE id = ?").get(uploaded.jobId).movie_id, movie.id);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM movies WHERE id = ?").get(movie.id).count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE movie_id = ?").get(movie.id).count, 1);

    let job;
    for (let attempt = 0; attempt < 120; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/admin/jobs`, {
            headers: { Cookie: adminCookie }
        });
        assert.equal(response.status, 200);
        const data = await response.json();
        job = data.jobs.find((item) => item.id === uploaded.jobId);
        if (job && ["completed", "failed"].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    assert.ok(job, "fingerprint job should be saved in the queue");
    assert.equal(job.status, "completed", job.error || "fingerprint processing did not complete");
    assert.equal(job.total_segments, 1);
    assert.equal(job.completed_segments, 1);
    assert.equal(job.failed_segments, 0);

    const fingerprints = database.prepare(`
        SELECT kind, COUNT(*) AS count
        FROM fingerprints WHERE movie_id = ?
        GROUP BY kind
    `).all(movie.id);
    const counts = Object.fromEntries(fingerprints.map((item) => [item.kind, item.count]));
    assert.ok(counts.image > 0, "decoded video frames should produce stored visual hashes");
    assert.ok(counts.audio > 0, "Chromaprint should produce stored audio fingerprints");
    assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM segments WHERE movie_id = ? AND status = 'completed'").get(movie.id).count,
        1
    );
});

test("rejects duplicate episode uploads without creating duplicate movie, job, or fingerprints", async () => {
    const existing = database.prepare(`
        SELECT id FROM movies WHERE title = 'Merlin Season 01 Episode 01'
    `).get();
    assert.ok(existing, "the preceding test must have registered the episode");
    const originalCounts = {
        movies: database.prepare("SELECT COUNT(*) AS count FROM movies WHERE id = ?").get(existing.id).count,
        jobs: database.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE movie_id = ?").get(existing.id).count,
        fingerprints: database.prepare("SELECT COUNT(*) AS count FROM fingerprints WHERE movie_id = ?").get(existing.id).count
    };

    const response = await uploadAuthorizedEpisode();
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.movieId, existing.id);
    assert.deepEqual({
        movies: database.prepare("SELECT COUNT(*) AS count FROM movies WHERE id = ?").get(existing.id).count,
        jobs: database.prepare("SELECT COUNT(*) AS count FROM processing_jobs WHERE movie_id = ?").get(existing.id).count,
        fingerprints: database.prepare("SELECT COUNT(*) AS count FROM fingerprints WHERE movie_id = ?").get(existing.id).count
    }, originalCounts);

    const uploads = fs.readdirSync(process.env.MERLIN_MOVIE_UPLOAD_DIR);
    assert.equal(uploads.length, 1, "the duplicate upload temporary file should be removed");
});
