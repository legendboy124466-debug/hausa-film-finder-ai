const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { createBackup, restoreBackup } = require("../scripts/backup");

function sqliteCliAvailable() {
    try {
        execFileSync(process.env.SQLITE3_PATH || "sqlite3", ["--version"], { stdio: "ignore", windowsHide: true });
        return true;
    } catch {
        return false;
    }
}

test("backup requires an explicit quiesced application", async () => {
    const previous = process.env.HF_BACKUP_QUIESCED;
    delete process.env.HF_BACKUP_QUIESCED;
    try {
        await assert.rejects(createBackup({ destination: "unused" }), /Stop the application first/);
    } finally {
        if (previous === undefined) delete process.env.HF_BACKUP_QUIESCED;
        else process.env.HF_BACKUP_QUIESCED = previous;
    }
});

test("SQLite backup and new-directory restore preserve data and verify SHA-256", {
    skip: !sqliteCliAvailable() && "SQLite command-line shell is required for the .backup integration test"
}, async (context) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "hf-backup-restore-test-"));
    context.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const dbPath = path.join(base, "source.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE movies (id TEXT PRIMARY KEY, movie_path TEXT); INSERT INTO movies VALUES ('fixture', 'media/movies/fixture.mp4');");
    db.close();

    const roots = {
        movies: path.join(base, "media", "movies"),
        posters: path.join(base, "media", "posters"),
        merlin: path.join(base, "media", "merlin"),
        social: path.join(base, "media", "social")
    };
    for (const directory of Object.values(roots)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(roots.movies, "authorized-fixture.mp4"), "fixture-video");
    fs.writeFileSync(path.join(roots.movies, "authorized-fixture.mp4.chrome.mp4"), "fixture-playback-copy");
    fs.writeFileSync(path.join(roots.posters, "poster.jpg"), "fixture-poster");
    fs.writeFileSync(path.join(roots.merlin, "episode-01.mp4"), "fixture-merlin");
    fs.writeFileSync(path.join(roots.social, "attachment.jpg"), "fixture-social");

    const backupRoot = path.join(base, "external-backup-device");
    fs.mkdirSync(backupRoot);
    const previousQuiesced = process.env.HF_BACKUP_QUIESCED;
    process.env.HF_BACKUP_QUIESCED = "YES";
    try {
        const backupDirectory = await createBackup({
            destination: backupRoot,
            database: dbPath,
            movies: roots.movies,
            posters: roots.posters,
            merlin: roots.merlin,
            social: roots.social,
            "merlin-movies": path.join(roots.movies, "merlin")
        });
        const manifest = JSON.parse(fs.readFileSync(path.join(backupDirectory, "manifest.json"), "utf8"));
        assert.equal(manifest.database, "database/hausa-film-finder.sqlite");
        assert.ok(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
        assert.ok(manifest.files.some((entry) => entry.path.endsWith("authorized-fixture.mp4.chrome.mp4")));
        assert.ok(manifest.files.some((entry) => entry.path.endsWith("episode-01.mp4")));
        assert.ok(manifest.files.some((entry) => entry.path.endsWith("poster.jpg")));
        assert.ok(manifest.files.some((entry) => entry.path.endsWith("attachment.jpg")));

        const restoreTarget = path.join(base, "restore-test");
        await restoreBackup({ source: backupDirectory, target: restoreTarget });
        const restoredDb = new DatabaseSync(path.join(restoreTarget, manifest.database), { readOnly: true });
        try {
            assert.equal(restoredDb.prepare("SELECT movie_path FROM movies WHERE id='fixture'").get().movie_path,
                "media/movies/fixture.mp4");
            assert.deepEqual(restoredDb.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
            assert.deepEqual(restoredDb.prepare("PRAGMA foreign_key_check").all(), []);
        } finally {
            restoredDb.close();
        }
        assert.equal(
            crypto.createHash("sha256").update(fs.readFileSync(path.join(roots.movies, "authorized-fixture.mp4"))).digest("hex"),
            manifest.files.find((entry) => entry.path.endsWith("authorized-fixture.mp4")).sha256
        );
    } finally {
        if (previousQuiesced === undefined) delete process.env.HF_BACKUP_QUIESCED;
        else process.env.HF_BACKUP_QUIESCED = previousQuiesced;
    }
});
