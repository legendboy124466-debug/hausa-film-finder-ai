const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("cloud container template excludes local database, uploads, videos, and secrets", () => {
    const dockerignore = read(".dockerignore");
    for (const entry of [".env", ".env.*", "backups/", "backend/data/", "uploads/", "videos/", "*.sqlite", "*.mkv", "*.mp4"]) {
        assert.ok(dockerignore.split(/\r?\n/).includes(entry), `missing Docker exclusion ${entry}`);
    }
});

test("cloud template separates persistent SQLite/media from temporary sample files", () => {
    const compose = read("deploy/compose.yaml");
    const appService = compose.split("\n  https_proxy:")[0];
    assert.match(compose, /target: \/var\/lib\/hausa-film-finder\/database/);
    assert.match(compose, /target: \/var\/lib\/hausa-film-finder\/media/);
    assert.match(compose, /- \/tmp\/hf-processing:.*size=1073741824/);
    assert.match(compose, /SOCIAL_UPLOAD_DIR: \/var\/lib\/hausa-film-finder\/media\/social/);
    assert.match(compose, /FINGERPRINT_MAX_CONCURRENT_JOBS: "1"/);
    assert.doesNotMatch(appService, /^\s+ports:/m);
    assert.match(compose, /profiles: \[public\]/);
});

test("cloud image includes all three media tools and runs without root", () => {
    const dockerfile = read("deploy/Dockerfile");
    assert.match(dockerfile, /apt-get install[^\n]*ffmpeg libchromaprint-tools/);
    assert.match(dockerfile, /FPCALC_PATH=\/usr\/bin\/fpcalc/);
    assert.match(dockerfile, /FFPROBE_PATH=\/usr\/bin\/ffprobe/);
    assert.match(dockerfile, /USER node/);
    assert.doesNotMatch(dockerfile, /COPY[^\n]*(?:uploads|videos|backend\/data|\.env)/);
});

test("uploaded movie extensions and local SQLite files are ignored by Git", () => {
    const ignored = read(".gitignore").split(/\r?\n/);
    for (const entry of ["*.avi", "*.mkv", "*.mp4", "*.mov", "*.webm", "*.sqlite", "*.sqlite-wal"]) {
        assert.ok(ignored.includes(entry), `missing Git exclusion ${entry}`);
    }
});
