const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hausa-film-tests-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "test.sqlite");
process.env.MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "movies");
process.env.POSTER_UPLOAD_DIR = path.join(temporaryDirectory, "posters");
process.env.MERLIN_UPLOAD_DIR = path.join(temporaryDirectory, "merlin");
process.env.ADMIN_USERNAME = "test-admin";
process.env.ADMIN_PASSWORD = "test-password-that-is-long-enough";
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.OPENAI_API_KEY = "";
process.env.NODE_ENV = "test";

const { splitDuration } = require("../backend/segments");
const { hashGrayPixels } = require("../fingerprint/image");
const {
    hammingDistance,
    compareAudioFingerprints
} = require("../fingerprint/matcher");
const originalLoadEnvFile = process.loadEnvFile;
process.loadEnvFile = () => {};
let createApp;
try {
    ({ createApp } = require("../backend/server"));
} finally {
    process.loadEnvFile = originalLoadEnvFile;
}
const { database } = require("../backend/database");
const { audioMatch, AUDIO_THRESHOLD, result } = require("../backend/matching");
const { verifyFingerprints } = require("../backend/processor");
const { ensureChromePlayback, probeMedia } = require("../backend/media");

let server;
let baseUrl;
let adminCookie;
const sampleVideoPath = path.join(temporaryDirectory, "sample.mp4");

before(async () => {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=2",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", sampleVideoPath
    ], { windowsHide: true, timeout: 120000 });
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

test("splits three-hour films into all 45 four-minute segments", () => {
    const segments = splitDuration(3 * 60 * 60);
    assert.equal(segments.length, 45);
    assert.equal(segments[0].startSeconds, 0);
    assert.equal(segments[44].startSeconds, 44 * 240);
    assert.equal(segments[44].endSeconds, 3 * 60 * 60);
});

test("includes the final shorter segment without extending movie duration", () => {
    const segments = splitDuration(490.25);
    assert.equal(segments.length, 3);
    assert.deepEqual(segments[2], {
        segmentNumber: 3,
        startSeconds: 480,
        endSeconds: 490.25
    });
});

test("generates a real 64-bit difference hash from decoded grayscale pixels", () => {
    const flat = Buffer.alloc(72, 128);
    assert.equal(hashGrayPixels(flat), "0000000000000000");
    const descending = Buffer.alloc(72);
    for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 9; x += 1) descending[y * 9 + x] = 255 - x * 20;
    }
    assert.equal(hashGrayPixels(descending), "ffffffffffffffff");
    assert.equal(hammingDistance("0000000000000000", "0000000000000001"), 1);
});

test("compares genuine Chromaprint integer sequences by bit similarity", () => {
    assert.deepEqual(
        compareAudioFingerprints("123,456,789,10", "0,123,456,789,10,42"),
        { score: 1, offset: 1 }
    );
    assert.throws(() => compareAudioFingerprints("not-a-fingerprint", "1,2,3,4"));
});

test("converts incompatible video to a separate Chrome-compatible copy", async () => {
    const sourcePath = path.join(temporaryDirectory, "source.webm");
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "color=c=black:s=64x64:r=5:d=2",
        "-an", "-c:v", "libvpx-vp9", "-deadline", "realtime", sourcePath
    ], { windowsHide: true, timeout: 120000 });
    const original = fs.readFileSync(sourcePath);
    const playbackPath = await ensureChromePlayback(sourcePath);
    assert.notEqual(playbackPath, sourcePath);
    assert.equal(path.extname(playbackPath), ".mp4");
    assert.deepEqual(fs.readFileSync(sourcePath), original);
    const playbackInfo = await probeMedia(playbackPath);
    assert.equal(playbackInfo.videoCodec, "h264");
});

function audioSequence(seed, length) {
    let value = seed >>> 0;
    return Array.from({ length }, () => {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        return value >>> 0;
    });
}

function storeAudioFingerprint(movieId, timestampSeconds, fingerprint) {
    const now = new Date().toISOString();
    database.prepare(`
        INSERT INTO movies (id, title, original_title, studio, permission_confirmed, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(movieId, "Audio Timestamp Test", "Audio Timestamp Test", "Test Studio", now, now);
    database.prepare(`
        INSERT INTO fingerprints (
            movie_id, segment_number, kind, timestamp_seconds, hash, created_at
        ) VALUES (?, 1, 'audio', ?, ?, ?)
    `).run(movieId, timestampSeconds, fingerprint, now);
}

function removeAudioFingerprint(movieId) {
    database.prepare("DELETE FROM fingerprints WHERE movie_id = ?").run(movieId);
    database.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
}

test("audio offset points backward when the query sample is longer than stored audio", () => {
    const stored = audioSequence(0x12345678, 8);
    const query = [...audioSequence(0xabcdef01, 5), ...stored, ...audioSequence(0x98765432, 4)];
    const match = compareAudioFingerprints(query.join(","), stored.join(","));
    assert.equal(match.score, 1);
    assert.equal(match.offset, -5);
});

test("audio offset points forward when stored audio is longer than the query sample", () => {
    const stored = audioSequence(0x12345678, 6);
    const query = audioSequence(0xabcdef01, 10);
    const longerStored = [...audioSequence(0x98765432, 4), ...query, ...stored];
    const match = compareAudioFingerprints(query.join(","), longerStored.join(","));
    assert.equal(match.score, 1);
    assert.equal(match.offset, 4);
});

test("audio match reports the sample's actual position in the middle of a movie", () => {
    const movieId = crypto.randomUUID();
    const stored = audioSequence(0x10203040, 40);
    const sampleOffset = 17;
    const sample = stored.slice(sampleOffset, sampleOffset + 7);
    storeAudioFingerprint(movieId, 1200, stored.join(","));
    try {
        const match = audioMatch(sample.join(","));
        assert.equal(match.movie.id, movieId);
        assert.equal(match.score, 1);
        assert.equal(match.timestampSeconds, 1200 + sampleOffset * 1.48);
    } finally {
        removeAudioFingerprint(movieId);
    }
});

test("unrelated audio does not pass the existing recognition threshold", () => {
    const movieId = crypto.randomUUID();
    const stored = audioSequence(0x10203040, 24);
    const unrelated = audioSequence(0xdeadbeef, 12);
    storeAudioFingerprint(movieId, 300, stored.join(","));
    try {
        const candidate = audioMatch(unrelated.join(","));
        assert.ok(candidate.score < AUDIO_THRESHOLD);
        assert.equal(result(candidate, AUDIO_THRESHOLD).identified, false);
    } finally {
        removeAudioFingerprint(movieId);
    }
});

test("serves health and keeps unconfirmed legacy movies out of the public catalogue", async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).database, "sqlite");

    const response = await fetch(`${baseUrl}/api/movies`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).movies, []);

    const search = await fetch(`${baseUrl}/api/movies?q=Merlin`);
    assert.equal(search.status, 200);
    assert.deepEqual((await search.json()).movies, []);
});

test("allows the Capacitor HTTPS origin without opening credentialed CORS to other sites", async () => {
    const health = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: "https://localhost" }
    });
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("access-control-allow-origin"), "https://localhost");
    assert.equal(health.headers.get("access-control-allow-credentials"), "true");

    const preflight = await fetch(`${baseUrl}/api/admin/login`, {
        method: "OPTIONS",
        headers: {
            Origin: "https://localhost",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type"
        }
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-methods"), /POST/);
    assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

    const rejected = await fetch(`${baseUrl}/api/admin/login`, {
        method: "OPTIONS",
        headers: {
            Origin: "https://untrusted.example",
            "Access-Control-Request-Method": "POST"
        }
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
});

test("rejects movie identification requests without a sample file", async () => {
    const response = await fetch(`${baseUrl}/api/identify/image`, { method: "POST" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Zaɓi hoto/);
});

test("protects admin routes, authenticates securely, and requires explicit permission approval", async () => {
    const blocked = await fetch(`${baseUrl}/api/admin/jobs`);
    assert.equal(blocked.status, 401);

    // A successful login must clear this IP's failed-attempt counter.
    for (let attempt = 0; attempt < 7; attempt += 1) {
        const failed = await fetch(`${baseUrl}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "https://localhost" },
            body: JSON.stringify({ username: "wrong-user", password: "wrong-password" })
        });
        assert.equal(failed.status, 401);
    }

    const login = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://localhost" },
        body: JSON.stringify({
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        })
    });
    assert.equal(login.status, 200);

    for (let attempt = 0; attempt < 7; attempt += 1) {
        const failed = await fetch(`${baseUrl}/api/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: "https://localhost" },
            body: JSON.stringify({ username: "wrong-user", password: "wrong-password" })
        });
        assert.equal(failed.status, 401);
    }

    const loginAfterFailures = await fetch(`${baseUrl}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://localhost" },
        body: JSON.stringify({
            username: process.env.ADMIN_USERNAME,
            password: process.env.ADMIN_PASSWORD
        })
    });
    assert.equal(loginAfterFailures.status, 200);
    assert.match(login.headers.get("set-cookie"), /SameSite=None; Secure/);
    assert.equal(login.headers.get("access-control-allow-origin"), "https://localhost");
    adminCookie = login.headers.get("set-cookie").split(";")[0];

    const session = await fetch(`${baseUrl}/api/admin/me`, {
        headers: { Cookie: adminCookie }
    });
    assert.equal(session.status, 200);

    const pending = await fetch(`${baseUrl}/api/admin/movies`, {
        headers: { Cookie: adminCookie }
    });
    const pendingMovies = (await pending.json()).movies;
    assert.ok(pendingMovies.some((movie) => movie.id === "legacy-1" && !movie.permissionConfirmed));

    const approval = await fetch(`${baseUrl}/api/admin/movies/legacy-1/permission`, {
        method: "POST",
        headers: { Cookie: adminCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ permissionConfirmed: true })
    });
    assert.equal(approval.status, 200);

    const catalog = await fetch(`${baseUrl}/api/movies`);
    const movies = (await catalog.json()).movies;
    assert.ok(movies.some((movie) => movie.id === "legacy-1" && movie.title === "Merlin"));
});

test("uploads an authorized movie with optional poster and season metadata, and streams byte ranges", async () => {
    const formData = new FormData();
    formData.append("movie", new Blob([fs.readFileSync(sampleVideoPath)], { type: "video/mp4" }), "sample.mp4");
    formData.append("title", "Test Movie");
    formData.append("hausaTitle", "Fim Gwaji");
    formData.append("studio", "Test Studio");
    formData.append("description", "Bayanin gwaji");
    formData.append("seasonNumber", "2");
    formData.append("episodeNumber", "4");
    formData.append("permissionConfirmed", "true");
    const uploaded = await fetch(`${baseUrl}/api/admin/movies`, {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: formData
    });
    assert.equal(uploaded.status, 202);
    const { movieId } = await uploaded.json();

    const detailResponse = await fetch(`${baseUrl}/api/movies/${movieId}`);
    assert.equal(detailResponse.status, 200);
    const { movie } = await detailResponse.json();
    assert.equal(movie.hausaTitle, "Fim Gwaji");
    assert.equal(movie.description, "Bayanin gwaji");
    assert.deepEqual(movie.episodes, [{ seasonNumber: 2, episodeNumber: 4 }]);
    assert.equal(movie.hasVideo, true);
    assert.equal(movie.posterUrl, null);
    const uploadedPath = database.prepare("SELECT movie_path FROM movies WHERE id = ?").get(movieId).movie_path;
    assert.ok(fs.statSync(uploadedPath).size > 0);
    assert.doesNotThrow(() => fs.accessSync(uploadedPath, fs.constants.R_OK));

    const duplicateForm = new FormData();
    duplicateForm.append("movie", new Blob([fs.readFileSync(sampleVideoPath)], { type: "video/mp4" }), "sample.mp4");
    duplicateForm.append("title", "Test Movie");
    duplicateForm.append("studio", "Test Studio");
    duplicateForm.append("seasonNumber", "2");
    duplicateForm.append("episodeNumber", "4");
    duplicateForm.append("permissionConfirmed", "true");
    const duplicate = await fetch(`${baseUrl}/api/admin/movies`, {
        method: "POST",
        headers: { Cookie: adminCookie },
        body: duplicateForm
    });
    assert.equal(duplicate.status, 409);
    assert.equal(database.prepare(`
        SELECT COUNT(*) AS count FROM movies WHERE title = ? AND studio = ?
    `).get("Test Movie", "Test Studio").count, 1);

    const videoUrl = `${baseUrl}/api/movies/${movieId}/video`;
    const fileSize = fs.statSync(sampleVideoPath).size;
    const fullVideo = await fetch(videoUrl);
    assert.equal(fullVideo.status, 200);
    assert.equal(fullVideo.headers.get("content-type"), "video/mp4");
    assert.equal(fullVideo.headers.get("accept-ranges"), "bytes");
    assert.equal(fullVideo.headers.get("content-length"), String(fileSize));
    assert.deepEqual(Buffer.from(await fullVideo.arrayBuffer()), fs.readFileSync(sampleVideoPath));

    const videoResponse = await fetch(videoUrl, {
        headers: { Range: "bytes=7-11" }
    });
    assert.equal(videoResponse.status, 206);
    assert.deepEqual(
        Buffer.from(await videoResponse.arrayBuffer()),
        fs.readFileSync(sampleVideoPath).subarray(7, 12)
    );
    assert.equal(videoResponse.headers.get("content-type"), "video/mp4");
    assert.equal(videoResponse.headers.get("content-range"), `bytes 7-11/${fileSize}`);
    assert.equal(videoResponse.headers.get("content-length"), "5");

    const invalidRange = await fetch(videoUrl, {
        headers: { Range: `bytes=${fileSize}-${fileSize + 10}` }
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), `bytes */${fileSize}`);

    const blockedMovie = await fetch(`${baseUrl}/api/movies/legacy-1/video`);
    assert.equal(blockedMovie.status, 404);
});

test("does not verify a job as completed until every segment has real fingerprints", () => {
    const movieId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
        INSERT INTO movies (id, title, original_title, studio, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(movieId, "Fingerprint Verification", "Fingerprint Verification", "Test Studio", now, now);
    const addSegment = database.prepare(`
        INSERT INTO segments (movie_id, segment_number, start_seconds, end_seconds, status, updated_at)
        VALUES (?, ?, ?, ?, 'completed', ?)
    `);
    addSegment.run(movieId, 1, 0, 60, now);
    addSegment.run(movieId, 2, 60, 120, now);
    const addFingerprint = database.prepare(`
        INSERT INTO fingerprints (movie_id, segment_number, kind, timestamp_seconds, hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    try {
        assert.equal(verifyFingerprints(movieId, 2, false), false);
        addFingerprint.run(movieId, 1, "image", 0, "frame-hash-1", now);
        assert.equal(verifyFingerprints(movieId, 2, false), false);
        addFingerprint.run(movieId, 2, "image", 60, "frame-hash-2", now);
        assert.equal(verifyFingerprints(movieId, 2, false), true);
        assert.equal(verifyFingerprints(movieId, 2, true), false);
        addFingerprint.run(movieId, 1, "audio", 0, "audio-hash-1", now);
        addFingerprint.run(movieId, 2, "audio", 60, "audio-hash-2", now);
        assert.equal(verifyFingerprints(movieId, 2, true), true);
        assert.equal(verifyFingerprints(movieId, 3, false), false);
    } finally {
        database.prepare("DELETE FROM fingerprints WHERE movie_id = ?").run(movieId);
        database.prepare("DELETE FROM segments WHERE movie_id = ?").run(movieId);
        database.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
    }
});

test("admin can edit movie metadata and delete its managed media after confirmation", async () => {
    const movieId = crypto.randomUUID();
    const moviePath = path.join(process.env.MOVIE_UPLOAD_DIR, `${movieId}.mp4`);
    const posterFilename = `${movieId}.png`;
    const posterPath = path.join(process.env.POSTER_UPLOAD_DIR, posterFilename);
    fs.mkdirSync(path.dirname(moviePath), { recursive: true });
    fs.mkdirSync(path.dirname(posterPath), { recursive: true });
    fs.copyFileSync(sampleVideoPath, moviePath);
    fs.writeFileSync(posterPath, "admin-delete-test-poster");
    const now = new Date().toISOString();
    database.prepare(`
        INSERT INTO movies (
            id, title, original_title, studio, movie_path, poster_path, poster_filename,
            permission_confirmed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(movieId, "Admin Edit Test", "Admin Edit Test", "Admin Edit Studio",
        moviePath, `/uploads/posters/${posterFilename}`, posterFilename, now, now);

    try {
        const edited = await fetch(`${baseUrl}/api/admin/movies/${movieId}`, {
            method: "PATCH",
            headers: { Cookie: adminCookie, "Content-Type": "application/json" },
            body: JSON.stringify({
                title: "Edited Movie", hausaTitle: "Fim da aka gyara", language: "Hausa",
                actors: ["Jarumi Gwaji"], studio: "Edited Studio", country: "Nigeria", year: 2020,
                description: "Updated description", categories: ["Drama"],
                episodes: [{ seasonNumber: 1, episodeNumber: 2 }]
            })
        });
        assert.equal(edited.status, 200);
        const row = database.prepare("SELECT * FROM movies WHERE id = ?").get(movieId);
        assert.equal(row.title, "Edited Movie");
        assert.equal(row.language, "Hausa");
        assert.deepEqual(JSON.parse(row.actors_json), ["Jarumi Gwaji"]);
        assert.deepEqual(JSON.parse(row.episodes_json), [{ seasonNumber: 1, episodeNumber: 2 }]);

        const deleted = await fetch(`${baseUrl}/api/admin/movies/${movieId}`, {
            method: "DELETE",
            headers: { Cookie: adminCookie }
        });
        assert.equal(deleted.status, 200);
        assert.equal(database.prepare("SELECT id FROM movies WHERE id = ?").get(movieId), undefined);
        assert.equal(fs.existsSync(moviePath), false);
        assert.equal(fs.existsSync(posterPath), false);
    } finally {
        database.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
        fs.rmSync(moviePath, { force: true });
        fs.rmSync(posterPath, { force: true });
    }
});

test("public and admin status never display Completed when a stored fingerprint is missing", async () => {
    const movieId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    database.prepare(`
        INSERT INTO movies (
            id, title, original_title, studio, permission_confirmed, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
    `).run(movieId, "Unverified Completion", "Unverified Completion", "Test Studio", now, now);
    database.prepare(`
        INSERT INTO processing_jobs (
            id, movie_id, status, total_segments, completed_segments, created_at, updated_at
        ) VALUES (?, ?, 'completed', 1, 1, ?, ?)
    `).run(jobId, movieId, now, now);
    database.prepare(`
        INSERT INTO segments (movie_id, segment_number, start_seconds, end_seconds, status, updated_at)
        VALUES (?, 1, 0, 60, 'completed', ?)
    `).run(movieId, now);
    try {
        const detailResponse = await fetch(`${baseUrl}/api/movies/${movieId}`);
        assert.equal(detailResponse.status, 200);
        assert.equal((await detailResponse.json()).movie.processingStatus, "failed");
        const jobsResponse = await fetch(`${baseUrl}/api/admin/jobs`, {
            headers: { Cookie: adminCookie }
        });
        const jobs = (await jobsResponse.json()).jobs;
        const job = jobs.find((entry) => entry.id === jobId);
        assert.equal(job.status, "failed");
        assert.match(job.error, /Fingerprint verification failed/);
    } finally {
        database.prepare("DELETE FROM fingerprints WHERE movie_id = ?").run(movieId);
        database.prepare("DELETE FROM segments WHERE movie_id = ?").run(movieId);
        database.prepare("DELETE FROM processing_jobs WHERE movie_id = ?").run(movieId);
        database.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
    }
});

test("provides ten protected Merlin slots with upload, poster, range playback, replacement, and deletion", async () => {
    const publicCatalog = await fetch(`${baseUrl}/api/merlin`);
    assert.equal(publicCatalog.status, 200);
    const emptyEpisodes = (await publicCatalog.json()).episodes;
    assert.equal(emptyEpisodes.length, 10);
    assert.deepEqual(emptyEpisodes.map((episode) => episode.episodeNumber), [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ]);
    assert.ok(emptyEpisodes.every((episode) => !episode.hasVideo));

    const blockedAdminList = await fetch(`${baseUrl}/api/admin/merlin`);
    assert.equal(blockedAdminList.status, 401);
    const blockedUpload = await fetch(`${baseUrl}/api/admin/merlin/1`, {
        method: "PUT",
        headers: { Cookie: "invalid" },
        body: new FormData()
    });
    assert.equal(blockedUpload.status, 401);

    for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber += 1) {
        const formData = new FormData();
        formData.append("title", `Merlin Episode ${episodeNumber}`);
        formData.append("description", `Bayani na episode ${episodeNumber}`);
        formData.append(
            "video",
            new Blob([fs.readFileSync(sampleVideoPath)], { type: "video/mp4" }),
            `Merlin ${String(episodeNumber).padStart(2, "0")}.mp4`
        );
        const upload = await fetch(`${baseUrl}/api/admin/merlin/${episodeNumber}`, {
            method: "PUT",
            headers: { Cookie: adminCookie },
            body: formData
        });
        assert.equal(upload.status, 200, `episode ${episodeNumber} upload`);
    }

    const posterForm = new FormData();
    posterForm.append("poster", new Blob(["poster-one"], { type: "image/png" }), "Merlin 01.png");
    const posterUpload = await fetch(`${baseUrl}/api/admin/merlin/1/poster`, {
        method: "PUT",
        headers: { Cookie: adminCookie },
        body: posterForm
    });
    assert.equal(posterUpload.status, 200);

    const adminEpisodesResponse = await fetch(`${baseUrl}/api/admin/merlin`, {
        headers: { Cookie: adminCookie }
    });
    assert.equal(adminEpisodesResponse.status, 200);
    const adminEpisodes = (await adminEpisodesResponse.json()).episodes;
    assert.equal(adminEpisodes.length, 10);
    assert.ok(adminEpisodes.every((episode) => episode.hasVideo));
    assert.equal(adminEpisodes[0].title, "Merlin Episode 1");
    assert.equal(adminEpisodes[0].description, "Bayani na episode 1");
    assert.ok(adminEpisodes[0].posterUrl);

    const videoResponse = await fetch(`${baseUrl}/api/merlin/1/video`, {
        headers: { Range: "bytes=0-4" }
    });
    assert.equal(videoResponse.status, 206);
    assert.deepEqual(
        Buffer.from(await videoResponse.arrayBuffer()),
        fs.readFileSync(sampleVideoPath).subarray(0, 5)
    );
    assert.match(videoResponse.headers.get("content-range"), /^bytes 0-4\//);

    const posterResponse = await fetch(`${baseUrl}/api/merlin/1/poster`);
    assert.equal(posterResponse.status, 200);
    assert.equal(posterResponse.headers.get("content-type"), "image/png");
    assert.equal(await posterResponse.text(), "poster-one");

    const oldVideoFiles = fs.readdirSync(process.env.MERLIN_UPLOAD_DIR).filter((name) => name.endsWith(".mp4"));
    const replacement = new FormData();
    replacement.append("title", "Merlin Episode One — Sabon Take");
    replacement.append("description", "An sabunta bayanin.");
    replacement.append(
        "video",
        new Blob([fs.readFileSync(sampleVideoPath)], { type: "video/mp4" }),
        "replacement.mp4"
    );
    const replaced = await fetch(`${baseUrl}/api/admin/merlin/1`, {
        method: "PUT",
        headers: { Cookie: adminCookie },
        body: replacement
    });
    assert.equal(replaced.status, 200);
    assert.equal(fs.readdirSync(process.env.MERLIN_UPLOAD_DIR).filter((name) => name.endsWith(".mp4")).length, 10);
    assert.equal(oldVideoFiles.length, 10);

    const metadataOnly = new FormData();
    metadataOnly.append("title", "Merlin Episode Two — Edit");
    metadataOnly.append("description", "An gyara rubutun kawai.");
    const edited = await fetch(`${baseUrl}/api/admin/merlin/2`, {
        method: "PUT",
        headers: { Cookie: adminCookie },
        body: metadataOnly
    });
    assert.equal(edited.status, 200);
    const editedEpisode = (await (await fetch(`${baseUrl}/api/admin/merlin`, {
        headers: { Cookie: adminCookie }
    })).json()).episodes[1];
    assert.equal(editedEpisode.title, "Merlin Episode Two — Edit");
    assert.equal(editedEpisode.hasVideo, true);

    const deleted = await fetch(`${baseUrl}/api/admin/merlin/10/video`, {
        method: "DELETE",
        headers: { Cookie: adminCookie }
    });
    assert.equal(deleted.status, 200);
    const afterDelete = (await (await fetch(`${baseUrl}/api/merlin`)).json()).episodes;
    assert.equal(afterDelete.length, 10);
    assert.equal(afterDelete[9].hasVideo, false);
    assert.equal(afterDelete[9].title, "Merlin Episode 10");
    assert.equal((await fetch(`${baseUrl}/api/merlin/10/video`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/api/admin/merlin/11`, {
        headers: { Cookie: adminCookie }
    })).status, 404);
});

test("supports social registration, login, account, feed, and admin user review", async () => {
    const firstPassword = "social-test-password-1";
    const firstRegistration = await fetch(`${baseUrl}/api/social/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://localhost" },
        body: JSON.stringify({
            username: "social_test_one",
            fullName: "Social Test One",
            password: firstPassword
        })
    });
    assert.equal(firstRegistration.status, 201);
    assert.match(firstRegistration.headers.get("set-cookie"), /SameSite=None; Secure/);
    const firstUser = (await firstRegistration.json()).user;
    assert.equal(firstUser.username, "social_test_one");
    const firstCookie = firstRegistration.headers.get("set-cookie").split(";")[0];

    const secondRegistration = await fetch(`${baseUrl}/api/social/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: "social_test_two",
            fullName: "Social Test Two",
            password: "social-test-password-2"
        })
    });
    assert.equal(secondRegistration.status, 201);
    const secondCookie = secondRegistration.headers.get("set-cookie").split(";")[0];

    const me = await fetch(`${baseUrl}/api/social/me`, {
        headers: { Cookie: firstCookie }
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.username, "social_test_one");

    const profile = await fetch(`${baseUrl}/api/social/profile`, {
        method: "PUT",
        headers: { Cookie: firstCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
            fullName: "Updated Social Test",
            bio: "Test profile",
            isPrivate: false,
            messagePolicy: "everyone"
        })
    });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).profile.fullName, "Updated Social Test");

    const search = await fetch(`${baseUrl}/api/social/users/search?q=social_test_two`, {
        headers: { Cookie: firstCookie }
    });
    assert.equal(search.status, 200);
    assert.ok((await search.json()).users.some((user) => user.username === "social_test_two"));

    const post = await fetch(`${baseUrl}/api/social/posts`, {
        method: "POST",
        headers: { Cookie: firstCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Social route integration test" })
    });
    assert.equal(post.status, 201);

    const voicePostForm = new FormData();
    voicePostForm.append("content", "Safari audio format integration test");
    voicePostForm.append(
        "attachment",
        new Blob([Buffer.from("temporary audio test")], { type: "audio/mp4" }),
        "voice-message.m4a"
    );
    const voicePostResponse = await fetch(`${baseUrl}/api/social/posts`, {
        method: "POST",
        headers: { Cookie: firstCookie },
        body: voicePostForm
    });
    assert.equal(voicePostResponse.status, 201);
    const voicePost = (await voicePostResponse.json()).post;
    const storedVoice = database.prepare(`
        SELECT original_name, mime_type FROM social_media
        WHERE purpose = 'post' AND resource_id = ?
    `).get(voicePost.id);
    assert.deepEqual({ ...storedVoice }, {
        original_name: "voice-message.m4a",
        mime_type: "audio/mp4"
    });

    const feed = await fetch(`${baseUrl}/api/social/feed`, {
        headers: { Cookie: secondCookie }
    });
    assert.equal(feed.status, 200);
    assert.ok((await feed.json()).posts.some((item) => item.content === "Social route integration test"));

    const login = await fetch(`${baseUrl}/api/social/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "SOCIAL_TEST_ONE", password: firstPassword })
    });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).user.username, "social_test_one");

    const adminUsers = await fetch(`${baseUrl}/api/admin/social/users`, {
        headers: { Cookie: adminCookie }
    });
    assert.equal(adminUsers.status, 200);
    assert.ok((await adminUsers.json()).users.some((user) => user.username === "social_test_one"));
});

test.skip("does not claim Mohammad AI is connected without server credentials", async () => {
    const response = await fetch(`${baseUrl}/api/assistant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Sannu" })
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /OPENAI_API_KEY/);
});

test.skip("returns a text-only Hausa-first response from the OpenAI Responses API", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const previousModel = process.env.OPENAI_MODEL;
    const originalFetch = global.fetch;
    let requestUrl;
    let requestOptions;
    process.env.OPENAI_API_KEY = "test-openai-key";
    delete process.env.OPENAI_MODEL;
    global.fetch = async (url, options) => {
        if (url !== "https://api.openai.com/v1/responses") {
            return originalFetch(url, options);
        }
        requestUrl = url;
        requestOptions = options;
        return Response.json({
            output: [{ content: [{ type: "output_text", text: "Sannu! Zan taimaka maka." }] }]
        });
    };

    try {
        const response = await fetch(`${baseUrl}/api/assistant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Yaya zan nemo fim?" })
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { answer: "Sannu! Zan taimaka maka." });
        assert.equal(requestUrl, "https://api.openai.com/v1/responses");
        assert.equal(requestOptions.headers.Authorization, "Bearer test-openai-key");
        const requestBody = JSON.parse(requestOptions.body);
        assert.equal(requestBody.model, "gpt-4.1-mini");
        assert.match(requestBody.input[0].content, /Ka amsa da Hausa sai an nemi Turanci/);
        assert.deepEqual(requestBody.input[1], {
            role: "user",
            content: "Yaya zan nemo fim?"
        });
        assert.equal("audio" in requestBody, false);
        assert.equal("tools" in requestBody, false);
    } finally {
        global.fetch = originalFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
        if (previousModel === undefined) delete process.env.OPENAI_MODEL;
        else process.env.OPENAI_MODEL = previousModel;
    }
});

test.skip("explains invalid OpenAI credentials without leaking upstream details", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const originalFetch = global.fetch;
    process.env.OPENAI_API_KEY = "test-openai-key";
    global.fetch = async (url, options) => {
        if (url !== "https://api.openai.com/v1/responses") {
            return originalFetch(url, options);
        }
        return Response.json({
            error: { code: "invalid_api_key", message: "private upstream detail" }
        }, { status: 401 });
    };

    try {
        const response = await fetch(`${baseUrl}/api/assistant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Sannu" })
        });
        const payload = await response.json();
        assert.equal(response.status, 503);
        assert.match(payload.error, /API_KEY ɗin bai inganta ba/);
        assert.doesNotMatch(payload.error, /private upstream detail/);
    } finally {
        global.fetch = originalFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
    }
});

test.skip("clearly reports an OpenAI account with exhausted credits", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    const originalFetch = global.fetch;
    process.env.OPENAI_API_KEY = "test-openai-key";
    global.fetch = async (url, options) => {
        if (url !== "https://api.openai.com/v1/responses") {
            return originalFetch(url, options);
        }
        return Response.json({
            error: { code: "insufficient_quota", message: "private billing detail" }
        }, { status: 429 });
    };

    try {
        const response = await fetch(`${baseUrl}/api/assistant`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Sannu" })
        });
        const payload = await response.json();
        assert.equal(response.status, 503);
        assert.match(payload.error, /credit/);
        assert.doesNotMatch(payload.error, /private billing detail/);
    } finally {
        global.fetch = originalFetch;
        if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previousKey;
    }
});

test("serves the supplied promotional poster as an image asset", async () => {
    const response = await fetch(`${baseUrl}/assets/hausa-film-finder-promotional-poster.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/png/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("serves install metadata and icons for iPhone and desktop browsers", async () => {
    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, "HAUSA FILM FINDER AI");
    assert.equal(manifest.short_name, "HAUSA FILM FINDER AI");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.deepEqual(
        manifest.icons.map((icon) => icon.sizes),
        ["192x192", "512x512"]
    );
    assert.equal(manifest.short_name, "HAUSA FILM FINDER AI");

    const htmlResponse = await fetch(`${baseUrl}/`);
    const html = await htmlResponse.text();
    assert.match(html, /<title>HAUSA FILM FINDER AI<\/title>/);
    assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
    assert.match(html, /name="apple-mobile-web-app-title" content="HAUSA FILM FINDER AI"/);
    assert.match(html, /name="viewport" content="[^"]*viewport-fit=cover"/);
    assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.match(html, /aria-label="HAUSA FILM FINDER AI — gida"/);

    const adminResponse = await fetch(`${baseUrl}/admin`);
    assert.equal(adminResponse.status, 200);
    const adminHtml = await adminResponse.text();
    assert.match(adminHtml, /<title>HAUSA FILM FINDER AI<\/title>/);
    assert.match(adminHtml, /name="apple-mobile-web-app-title" content="HAUSA FILM FINDER AI"/);
    assert.match(adminHtml, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
    assert.match(adminHtml, /sizes="192x192" href="\/assets\/app-icon-192\.png"/);
    assert.match(adminHtml, /sizes="512x512" href="\/assets\/app-icon-512\.png"/);
    assert.match(adminHtml, /id="movieBulkForm"/);
    assert.match(adminHtml, /id="movieBulkFiles"[^>]*multiple/);
    assert.match(adminHtml, /id="actors"/);
    const adminScriptResponse = await fetch(`${baseUrl}/admin/admin.js`);
    assert.equal(adminScriptResponse.status, 200);
    const adminScript = await adminScriptResponse.text();
    assert.match(adminScript, /uploadGenericMovie/);
    assert.match(adminScript, /createMovieEditPanel/);

    for (const url of [
        "/apple-touch-icon.png",
        "/assets/apple-touch-icon.png",
        "/assets/app-icon-192.png",
        "/assets/app-icon-512.png"
    ]) {
        const iconResponse = await fetch(`${baseUrl}${url}`);
        assert.equal(iconResponse.status, 200, `${url} should be available`);
        assert.match(iconResponse.headers.get("content-type"), /image\/png/);
        const bytes = Buffer.from(await iconResponse.arrayBuffer());
        assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
});
