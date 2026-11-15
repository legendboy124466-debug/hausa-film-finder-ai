const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const migration = require("../backend/migrations/001-merlin-season-1");

function withTemporaryDatabase(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hff-merlin-migration-test-"));
    const databasePath = path.join(directory, "isolated-test.sqlite");
    const database = new DatabaseSync(databasePath);
    try {
        database.exec(`
            PRAGMA foreign_keys = ON;
            CREATE TABLE movies (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                movie_path TEXT
            );
            CREATE TABLE processing_jobs (
                id TEXT PRIMARY KEY,
                movie_id TEXT NOT NULL REFERENCES movies(id)
            );
            CREATE TABLE segments (
                movie_id TEXT NOT NULL REFERENCES movies(id),
                segment_number INTEGER NOT NULL,
                PRIMARY KEY (movie_id, segment_number)
            );
            CREATE TABLE fingerprints (
                id INTEGER PRIMARY KEY,
                movie_id TEXT NOT NULL REFERENCES movies(id),
                segment_number INTEGER NOT NULL,
                kind TEXT NOT NULL,
                timestamp_seconds REAL NOT NULL,
                hash TEXT NOT NULL
            );
        `);
        run(database);
    } finally {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function addMovie(database, id) {
    database.prepare("INSERT INTO movies (id, title) VALUES (?, ?)").run(id, `Test ${id}`);
}

function addMapping(database, { movieId, episodeNumber, sha256 }) {
    database.prepare(`
        INSERT INTO merlin_movie_uploads (
            movie_id, season_number, episode_number, sha256, created_at
        ) VALUES (?, 1, ?, ?, ?)
    `).run(movieId, episodeNumber, sha256, new Date().toISOString());
}

test("importing the migration module does not execute it", () => {
    assert.equal(typeof migration.applyMerlinSeason1Migration, "function");
    assert.equal(migration.MIGRATION_VERSION, 1);
});

test("creates both Merlin tables and exactly Episodes 1–10", () => {
    withTemporaryDatabase((database) => {
        const result = migration.applyMerlinSeason1Migration(database);
        assert.equal(result.applied, true);
        for (const name of ["merlin_episodes", "merlin_movie_uploads"]) {
            assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
        }
        assert.deepEqual(
            database.prepare("SELECT episode_number FROM merlin_episodes ORDER BY episode_number").all()
                .map((row) => row.episode_number),
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        );
    });
});

test("running the migration twice is safe and does not duplicate slots or history", () => {
    withTemporaryDatabase((database) => {
        assert.equal(migration.applyMerlinSeason1Migration(database).applied, true);
        assert.equal(migration.applyMerlinSeason1Migration(database).applied, false);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_episodes").get().n, 10);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM app_migrations").get().n, 1);
    });
});

test("prevents a second movie mapping for the same Season 1 episode", () => {
    withTemporaryDatabase((database) => {
        migration.applyMerlinSeason1Migration(database);
        addMovie(database, "movie-a");
        addMovie(database, "movie-b");
        addMapping(database, { movieId: "movie-a", episodeNumber: 1, sha256: "a".repeat(64) });
        assert.throws(() => addMapping(database, {
            movieId: "movie-b", episodeNumber: 1, sha256: "b".repeat(64)
        }));
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_movie_uploads").get().n, 1);
    });
});

test("prevents one movie from mapping to two episodes and prevents duplicate SHA-256", () => {
    withTemporaryDatabase((database) => {
        migration.applyMerlinSeason1Migration(database);
        addMovie(database, "movie-a");
        addMovie(database, "movie-b");
        const hash = "c".repeat(64);
        addMapping(database, { movieId: "movie-a", episodeNumber: 1, sha256: hash });
        assert.throws(() => addMapping(database, {
            movieId: "movie-a", episodeNumber: 2, sha256: "d".repeat(64)
        }));
        assert.throws(() => addMapping(database, {
            movieId: "movie-b", episodeNumber: 2, sha256: hash
        }));
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_movie_uploads").get().n, 1);
    });
});

test("enforces movie and episode foreign keys and Season 1 episode bounds", () => {
    withTemporaryDatabase((database) => {
        migration.applyMerlinSeason1Migration(database);
        addMovie(database, "movie-a");
        assert.throws(() => addMapping(database, {
            movieId: "missing-movie", episodeNumber: 1, sha256: "e".repeat(64)
        }));
        assert.throws(() => addMapping(database, {
            movieId: "movie-a", episodeNumber: 11, sha256: "f".repeat(64)
        }));
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_movie_uploads").get().n, 0);
    });
});

test("preserves existing movies and creates no movie, job, segment, or fingerprint records", () => {
    withTemporaryDatabase((database) => {
        addMovie(database, "existing-movie");
        const before = database.prepare("SELECT id, title, movie_path FROM movies").all();
        migration.applyMerlinSeason1Migration(database);
        assert.deepEqual(database.prepare("SELECT id, title, movie_path FROM movies").all(), before);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM movies").get().n, 1);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM processing_jobs").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM segments").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM fingerprints").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_movie_uploads").get().n, 0);
    });
});

test("rolls back all migration changes when an existing mapping table is incompatible", () => {
    withTemporaryDatabase((database) => {
        database.exec("CREATE TABLE merlin_movie_uploads (movie_id TEXT PRIMARY KEY)");
        assert.throws(() => migration.applyMerlinSeason1Migration(database), /incompatible|lacks required/i);
        assert.equal(
            database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='merlin_episodes'").get(),
            undefined
        );
        assert.equal(
            database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_migrations'").get(),
            undefined
        );
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM merlin_movie_uploads").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM movies").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM processing_jobs").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM segments").get().n, 0);
        assert.equal(database.prepare("SELECT COUNT(*) AS n FROM fingerprints").get().n, 0);
    });
});
