const MIGRATION_ID = "merlin-season-1-episodes";
const MIGRATION_VERSION = 1;

const EPISODE_TITLES = Array.from({ length: 10 }, (_, index) =>
    `Merlin ${String(index + 1).padStart(2, "0")}`
);

function tableExists(database, tableName) {
    return Boolean(database.prepare(`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = ?
    `).get(tableName));
}

function columnInfo(database, tableName) {
    return database.prepare(`PRAGMA table_info("${tableName}")`).all();
}

function normalizedTableSql(database, tableName) {
    const row = database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName);
    return String(row?.sql || "").toLowerCase().replace(/\s+/g, "");
}

function uniqueIndexes(database, tableName) {
    return database.prepare(`PRAGMA index_list("${tableName}")`).all()
        .filter((index) => index.unique)
        .map((index) => database.prepare(`PRAGMA index_info("${index.name}")`).all()
            .map((column) => column.name));
}

function foreignKeys(database, tableName) {
    return database.prepare(`PRAGMA foreign_key_list("${tableName}")`).all()
        .map((key) => `${key.from}->${key.table}.${key.to}`);
}

function assertRequiredColumns(database, tableName, expected) {
    const columns = new Map(columnInfo(database, tableName).map((column) => [column.name, column]));
    for (const [name, type] of Object.entries(expected)) {
        const column = columns.get(name);
        if (!column || column.type.toUpperCase() !== type) {
            throw new Error(`Existing ${tableName} table is incompatible: expected ${name} ${type}.`);
        }
    }
}

function assertMerlinSchema(database) {
    if (!tableExists(database, "movies")) {
        throw new Error("The movies table must exist before the Merlin migration can run.");
    }
    assertRequiredColumns(database, "movies", { id: "TEXT" });

    assertRequiredColumns(database, "merlin_episodes", {
        episode_number: "INTEGER",
        title: "TEXT",
        description: "TEXT",
        video_filename: "TEXT",
        video_mime_type: "TEXT",
        poster_filename: "TEXT",
        poster_mime_type: "TEXT",
        updated_at: "TEXT"
    });
    const episodeNumber = columnInfo(database, "merlin_episodes")
        .find((column) => column.name === "episode_number");
    if (episodeNumber.pk !== 1 ||
        !normalizedTableSql(database, "merlin_episodes").includes("check(episode_numberbetween1and10)")) {
        throw new Error("Existing merlin_episodes table lacks the required 1–10 primary-key constraint.");
    }

    assertRequiredColumns(database, "merlin_movie_uploads", {
        movie_id: "TEXT",
        season_number: "INTEGER",
        episode_number: "INTEGER",
        sha256: "TEXT",
        created_at: "TEXT"
    });
    const uploadColumns = new Map(columnInfo(database, "merlin_movie_uploads")
        .map((column) => [column.name, column]));
    if (uploadColumns.get("movie_id").pk !== 1) {
        throw new Error("Existing merlin_movie_uploads table must use movie_id as its primary key.");
    }
    const indexes = uniqueIndexes(database, "merlin_movie_uploads");
    const hasUniquePair = indexes.some((columns) =>
        columns.length === 2 && columns.includes("season_number") && columns.includes("episode_number"));
    const hasUniqueHash = indexes.some((columns) =>
        columns.length === 1 && columns[0] === "sha256");
    const keys = foreignKeys(database, "merlin_movie_uploads");
    const hasMovieForeignKey = keys.includes("movie_id->movies.id");
    const hasEpisodeForeignKey = keys.includes("episode_number->merlin_episodes.episode_number");
    const uploadSql = normalizedTableSql(database, "merlin_movie_uploads");
    if (!hasUniquePair || !hasUniqueHash || !hasMovieForeignKey || !hasEpisodeForeignKey ||
        !uploadSql.includes("check(season_number=1)") ||
        !uploadSql.includes("check(episode_numberbetween1and10)")) {
        throw new Error("Existing merlin_movie_uploads table lacks required keys or Season 1 constraints.");
    }

    const invalidEpisode = database.prepare(`
        SELECT episode_number FROM merlin_episodes
        WHERE episode_number < 1 OR episode_number > 10
        LIMIT 1
    `).get();
    if (invalidEpisode) throw new Error("merlin_episodes contains an episode outside 1–10.");

    const invalidMapping = database.prepare(`
        SELECT movie_id FROM merlin_movie_uploads
        WHERE season_number != 1 OR episode_number < 1 OR episode_number > 10
        LIMIT 1
    `).get();
    if (invalidMapping) throw new Error("merlin_movie_uploads contains a mapping outside Season 1 Episodes 1–10.");
}

function applyMerlinSeason1Migration(database) {
    if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
        throw new TypeError("Pass an already-open SQLite database connection.");
    }
    if (database.isTransaction) {
        throw new Error("Run the Merlin migration outside any existing transaction.");
    }

    database.exec("PRAGMA foreign_keys = ON");
    if (database.prepare("PRAGMA foreign_keys").get().foreign_keys !== 1) {
        throw new Error("SQLite foreign-key enforcement could not be enabled.");
    }

    database.exec("BEGIN IMMEDIATE");
    try {
        database.exec(`
            CREATE TABLE IF NOT EXISTS app_migrations (
                migration_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS merlin_episodes (
                episode_number INTEGER PRIMARY KEY
                    CHECK (episode_number BETWEEN 1 AND 10),
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                video_filename TEXT,
                video_mime_type TEXT,
                poster_filename TEXT,
                poster_mime_type TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS merlin_movie_uploads (
                movie_id TEXT PRIMARY KEY NOT NULL
                    REFERENCES movies(id) ON DELETE RESTRICT,
                season_number INTEGER NOT NULL CHECK (season_number = 1),
                episode_number INTEGER NOT NULL
                    CHECK (episode_number BETWEEN 1 AND 10)
                    REFERENCES merlin_episodes(episode_number) ON DELETE RESTRICT,
                sha256 TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL,
                UNIQUE (season_number, episode_number)
            );
        `);

        const seedEpisode = database.prepare(`
            INSERT OR IGNORE INTO merlin_episodes (episode_number, title)
            VALUES (?, ?)
        `);
        for (let episodeNumber = 1; episodeNumber <= EPISODE_TITLES.length; episodeNumber += 1) {
            seedEpisode.run(episodeNumber, EPISODE_TITLES[episodeNumber - 1]);
        }

        assertMerlinSchema(database);
        const slots = database.prepare(`
            SELECT episode_number FROM merlin_episodes
            WHERE episode_number BETWEEN 1 AND 10
            ORDER BY episode_number
        `).all().map((row) => row.episode_number);
        if (slots.length !== 10 || slots.some((number, index) => number !== index + 1)) {
            throw new Error("Merlin Season 1 must contain exactly episode slots 1–10.");
        }

        const previous = database.prepare(`
            SELECT version FROM app_migrations WHERE migration_id = ?
        `).get(MIGRATION_ID);
        if (previous && previous.version !== MIGRATION_VERSION) {
            throw new Error(`Unexpected version for ${MIGRATION_ID}.`);
        }
        if (!previous) {
            database.prepare(`
                INSERT INTO app_migrations (migration_id, version, applied_at)
                VALUES (?, ?, ?)
            `).run(MIGRATION_ID, MIGRATION_VERSION, new Date().toISOString());
        }

        database.exec("COMMIT");
        return { migrationId: MIGRATION_ID, version: MIGRATION_VERSION, applied: !previous };
    } catch (error) {
        try { database.exec("ROLLBACK"); } catch {}
        throw error;
    }
}

module.exports = {
    MIGRATION_ID,
    MIGRATION_VERSION,
    applyMerlinSeason1Migration
};
