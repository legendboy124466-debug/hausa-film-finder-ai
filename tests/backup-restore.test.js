const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { backupProject, verifyBackup, restoreBackup, assertDatabaseIntegrity } = require("../scripts/backup-restore");

function makeFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hf-backup-restore-test-"));
    const databasePath = path.join(root, "live", "catalog.sqlite");
    const mediaPath = path.join(root, "live", "media");
    const destination = path.join(root, "backup-destination");
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(path.join(mediaPath, "posters"), { recursive: true });
    fs.writeFileSync(path.join(mediaPath, "posters", "sample.txt"), "temporary poster fixture\n");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);");
    return { root, databasePath, mediaPath, destination, database };
}

test("SQLite Online Backup API creates a hashed backup and restores into a new test directory", async () => {
    const fixture = makeFixture();
    try {
        const result = await backupProject({
            databasePath: fixture.databasePath,
            mediaPath: fixture.mediaPath,
            destination: fixture.destination,
            mediaQuiesced: true
        });
        assert.equal(result.manifest.media.fileCount, 1);
        assert.match(result.manifest.database.sha256, /^[a-f0-9]{64}$/);
        assert.match(result.manifest.media.files[0].sha256, /^[a-f0-9]{64}$/);
        assert.deepEqual((await verifyBackup(result.backupDirectory)).databaseChecks, {
            integrityCheck: "ok",
            foreignKeyCheck: "ok"
        });

        const restoreDirectory = path.join(fixture.root, "restore-test");
        const restored = await restoreBackup({ backupDirectory: result.backupDirectory, destination: restoreDirectory });
        assert.deepEqual(restored.databaseChecks, { integrityCheck: "ok", foreignKeyCheck: "ok" });
        assert.equal(fs.readFileSync(path.join(restoreDirectory, "media", "posters", "sample.txt"), "utf8"), "temporary poster fixture\n");
        const readRestored = new DatabaseSync(path.join(restoreDirectory, "database.sqlite"), { readOnly: true });
        assert.equal(readRestored.prepare("SELECT COUNT(*) AS count FROM child").get().count, 1);
        readRestored.close();
        assertDatabaseIntegrity(path.join(restoreDirectory, "database.sqlite"));
        assert.ok(fs.existsSync(fixture.databasePath), "the live source database remains in place");
    } finally {
        fixture.database.close();
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("backup requires a media write freeze and verification detects changed bytes", async () => {
    const fixture = makeFixture();
    try {
        await assert.rejects(backupProject({
            databasePath: fixture.databasePath,
            mediaPath: fixture.mediaPath,
            destination: fixture.destination,
            mediaQuiesced: false
        }), /media uploads/i);
        const result = await backupProject({
            databasePath: fixture.databasePath,
            mediaPath: fixture.mediaPath,
            destination: fixture.destination,
            mediaQuiesced: true
        });
        fs.writeFileSync(path.join(result.backupDirectory, "media", "posters", "sample.txt"), "changed bytes\n");
        await assert.rejects(verifyBackup(result.backupDirectory), /SHA-256/);
    } finally {
        fixture.database.close();
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});
