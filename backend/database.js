const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
const dataDirectory = path.join(__dirname, "data");
const databasePath = process.env.DATABASE_PATH || path.join(dataDirectory, "hausa-film-finder.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS studios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        permission_status TEXT NOT NULL DEFAULT 'unverified',
        authorized_links_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS movies (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        original_title TEXT NOT NULL,
        hausa_title TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT '',
        actors_json TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        year INTEGER,
        studio TEXT NOT NULL,
        categories_json TEXT NOT NULL DEFAULT '[]',
        episodes_json TEXT NOT NULL DEFAULT '[]',
        duration_seconds REAL,
        movie_path TEXT,
        poster_path TEXT,
        poster_filename TEXT,
        permission_confirmed INTEGER NOT NULL DEFAULT 0,
        has_audio INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processing_jobs (
        id TEXT PRIMARY KEY,
        movie_id TEXT NOT NULL REFERENCES movies(id),
        status TEXT NOT NULL,
        processing_stage TEXT NOT NULL DEFAULT 'pending',
        duration_seconds REAL,
        media_size_bytes INTEGER,
        media_mtime_ms REAL,
        total_segments INTEGER NOT NULL DEFAULT 0,
        completed_segments INTEGER NOT NULL DEFAULT 0,
        failed_segments INTEGER NOT NULL DEFAULT 0,
        pause_requested INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS segments (
        movie_id TEXT NOT NULL REFERENCES movies(id),
        segment_number INTEGER NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (movie_id, segment_number)
    );

    CREATE TABLE IF NOT EXISTS fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id TEXT NOT NULL REFERENCES movies(id),
        segment_number INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'audio')),
        timestamp_seconds REAL NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (movie_id, segment_number, kind, timestamp_seconds)
    );

    CREATE INDEX IF NOT EXISTS fingerprints_kind_time ON fingerprints(kind, timestamp_seconds);
    CREATE INDEX IF NOT EXISTS fingerprints_movie_segment ON fingerprints(movie_id, segment_number);
    CREATE INDEX IF NOT EXISTS jobs_status ON processing_jobs(status);

    CREATE TABLE IF NOT EXISTS merlin_episodes (
        episode_number INTEGER PRIMARY KEY CHECK (episode_number BETWEEN 1 AND 10),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        video_filename TEXT,
        video_mime_type TEXT,
        poster_filename TEXT,
        poster_mime_type TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO merlin_episodes (episode_number, title)
    VALUES
        (1, 'Kashi 1'),
        (2, 'Kashi 2'),
        (3, 'Kashi 3'),
        (4, 'Kashi 4'),
        (5, 'Kashi 5'),
        (6, 'Kashi 6'),
        (7, 'Kashi 7'),
        (8, 'Kashi 8'),
        (9, 'Kashi 9'),
        (10, 'Kashi 10');

    CREATE TABLE IF NOT EXISTS merlin_movie_uploads (
        movie_id TEXT PRIMARY KEY REFERENCES movies(id),
        season_number INTEGER NOT NULL CHECK (season_number >= 1),
        episode_number INTEGER NOT NULL CHECK (episode_number >= 1),
        sha256 TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        UNIQUE (season_number, episode_number)
    );

    CREATE TABLE IF NOT EXISTS owner_agent_tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS owner_agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone_number TEXT COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'agent', 'studio')),
        is_suspended INTEGER NOT NULL DEFAULT 0,
        can_create_groups INTEGER NOT NULL DEFAULT 1,
        session_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        photo_media_id TEXT,
        bio TEXT NOT NULL DEFAULT '',
        is_private INTEGER NOT NULL DEFAULT 0,
        message_policy TEXT NOT NULL DEFAULT 'everyone'
            CHECK (message_policy IN ('everyone', 'following', 'requests')),
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS follows (
        follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (follower_id, following_id),
        CHECK (follower_id != following_id)
    );

    CREATE TABLE IF NOT EXISTS follow_requests (
        requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (requester_id, target_id),
        CHECK (requester_id != target_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        post_type TEXT NOT NULL DEFAULT 'text' CHECK (post_type IN ('text', 'review', 'share')),
        movie_id TEXT REFERENCES movies(id) ON DELETE SET NULL,
        rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
        authorized_link TEXT,
        shared_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
        attachment_media_id TEXT,
        removed_at TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS post_likes (
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (post_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        movie_id TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        post_id TEXT NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
        body TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, movie_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        movie_id TEXT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, movie_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        participant_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        request_status TEXT NOT NULL DEFAULT 'accepted'
            CHECK (request_status IN ('pending', 'accepted', 'declined')),
        request_target_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (participant_a, participant_b),
        CHECK (participant_a < participant_b)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        movie_id TEXT REFERENCES movies(id) ON DELETE SET NULL,
        authorized_link TEXT,
        attachment_media_id TEXT,
        reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        delivered_at TEXT,
        read_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reaction TEXT NOT NULL CHECK (length(reaction) BETWEEN 1 AND 16),
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, reaction)
    );

    CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL DEFAULT '',
        movie_id TEXT REFERENCES movies(id) ON DELETE SET NULL,
        authorized_link TEXT,
        attachment_media_id TEXT,
        reply_to_id TEXT REFERENCES group_messages(id) ON DELETE SET NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_message_reactions (
        message_id TEXT NOT NULL REFERENCES group_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reaction TEXT NOT NULL CHECK (length(reaction) BETWEEN 1 AND 16),
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, reaction)
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        type TEXT NOT NULL,
        entity_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        read_at TEXT
    );

    CREATE TABLE IF NOT EXISTS blocks (
        blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id != blocked_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_type TEXT NOT NULL CHECK (target_type IN ('user', 'post', 'comment', 'message', 'group')),
        target_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_studio_follows (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        studio_id TEXT NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, studio_id)
    );

    CREATE TABLE IF NOT EXISTS social_media (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('profile', 'post', 'direct-message', 'group-message')),
        resource_id TEXT,
        created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS follows_target ON follows(following_id, created_at);
    CREATE INDEX IF NOT EXISTS posts_feed ON posts(created_at DESC) WHERE removed_at IS NULL;
    CREATE INDEX IF NOT EXISTS comments_post ON comments(post_id, created_at) WHERE removed_at IS NULL;
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS group_messages_feed ON group_messages(group_id, created_at);
`);

// Safe additive migration for older SQLite databases; existing rows and tables remain intact.
const movieColumns = new Set(database.prepare("PRAGMA table_info(movies)").all().map((column) => column.name));
if (!movieColumns.has("language")) {
    database.exec("ALTER TABLE movies ADD COLUMN language TEXT NOT NULL DEFAULT ''");
}
if (!movieColumns.has("actors_json")) {
    database.exec("ALTER TABLE movies ADD COLUMN actors_json TEXT NOT NULL DEFAULT '[]'");
}
const processingJobColumns = new Set(
    database.prepare("PRAGMA table_info(processing_jobs)").all().map((column) => column.name)
);
if (!processingJobColumns.has("processing_stage")) {
    database.exec("ALTER TABLE processing_jobs ADD COLUMN processing_stage TEXT NOT NULL DEFAULT 'pending'");
}
if (!processingJobColumns.has("media_size_bytes")) {
    database.exec("ALTER TABLE processing_jobs ADD COLUMN media_size_bytes INTEGER");
}
if (!processingJobColumns.has("media_mtime_ms")) {
    database.exec("ALTER TABLE processing_jobs ADD COLUMN media_mtime_ms REAL");
}
const userColumns = new Set(
    database.prepare("PRAGMA table_info(users)").all().map((column) => column.name)
);
if (!userColumns.has("phone_number")) {
    database.exec("ALTER TABLE users ADD COLUMN phone_number TEXT COLLATE NOCASE");
    database.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_phone_number_unique ON users(phone_number) WHERE phone_number IS NOT NULL");
}
const duplicateMovieJobs = database.prepare(`
    SELECT 1 FROM processing_jobs GROUP BY movie_id HAVING COUNT(*) > 1 LIMIT 1
`).get();
if (!duplicateMovieJobs) {
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_one_per_movie
        ON processing_jobs(movie_id)
    `);
}

function parseArray(value, key) {
    if (!Array.isArray(value)) return [];
    return value;
}

function seedLegacyMovies() {
    if (database.prepare("SELECT COUNT(*) AS count FROM movies").get().count > 0) return;

    const sources = [
        path.join(root, "database", "movies.json"),
        path.join(root, "movies.json")
    ];
    const records = [];
    for (const source of sources) {
        if (!fs.existsSync(source)) continue;
        const content = JSON.parse(fs.readFileSync(source, "utf8"));
        if (Array.isArray(content.movies)) records.push(...content.movies);
    }

    const insert = database.prepare(`
        INSERT OR IGNORE INTO movies (
            id, title, original_title, hausa_title, country, year, studio,
            categories_json, episodes_json, poster_path, permission_confirmed,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const [index, movie] of records.entries()) {
        if (!movie || typeof movie.title !== "string" || !movie.title.trim()) continue;
        const legacyPoster = path.join(root, "MERLIN SEASON 1.png");
        const posterPath = fs.existsSync(legacyPoster) && /merlin/i.test(movie.title)
            ? "/legacy-merlin-poster"
            : null;
        insert.run(
            `legacy-${movie.id ?? index + 1}`,
            movie.title.trim(),
            (movie.originalTitle || movie.title).trim(),
            typeof movie.hausaTitle === "string" ? movie.hausaTitle : "",
            typeof movie.country === "string" ? movie.country : "",
            Number.isInteger(Number(movie.year)) ? Number(movie.year) : null,
            typeof movie.studio === "string" ? movie.studio : "Ba a tantance studio ba",
            JSON.stringify(parseArray(movie.categories, "categories")),
            JSON.stringify(parseArray(movie.episodes, "episodes")),
            posterPath,
            now,
            now
        );
    }
}

function rowToMovie(row) {
    if (!row) return null;
    const posterUrl = resolveMoviePosterUrl(row);
    return {
        id: row.id,
        title: row.title,
        originalTitle: row.original_title,
        hausaTitle: row.hausa_title,
        language: row.language || "",
        actors: row.actors_json ? JSON.parse(row.actors_json) : [],
        description: row.description,
        country: row.country,
        year: row.year,
        studio: row.studio,
        categories: JSON.parse(row.categories_json),
        episodes: JSON.parse(row.episodes_json),
        durationSeconds: row.duration_seconds,
        posterUrl,
        posterFilename: row.poster_filename,
        hasVideo: Boolean(row.movie_path),
        permissionConfirmed: Boolean(row.permission_confirmed),
        fingerprintStatus: row.processing_status || null,
        processingStatus: row.processing_status || null
    };
}

function hasImageSignature(filePath) {
    try {
        if (!fs.statSync(filePath).isFile()) return false;
        const fd = fs.openSync(filePath, "r");
        try {
            const header = Buffer.alloc(12);
            const length = fs.readSync(fd, header, 0, header.length, 0);
            return (length >= 8 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
                (length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) ||
                (length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP");
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
}

function getSharedMerlinPoster() {
    const legacy = database.prepare("SELECT poster_path FROM movies WHERE id = 'legacy-1'").get();
    const expectedPath = path.join(root, "MERLIN SEASON 1.png");
    if (legacy?.poster_path !== "/legacy-merlin-poster" || !hasImageSignature(expectedPath)) return null;
    return { url: legacy.poster_path, filePath: expectedPath, mimeType: "image/png" };
}

function getMerlinEpisodePoster(episodeNumber) {
    const row = database.prepare(`
        SELECT poster_filename, poster_mime_type FROM merlin_episodes WHERE episode_number = ?
    `).get(episodeNumber);
    if (row?.poster_filename && path.basename(row.poster_filename) === row.poster_filename) {
        const uploadDirectory = path.resolve(process.env.MERLIN_UPLOAD_DIR || path.join(root, "uploads", "merlin"));
        const filePath = path.resolve(uploadDirectory, row.poster_filename);
        if (path.dirname(filePath) === uploadDirectory && hasImageSignature(filePath)) {
            return { url: `/api/merlin/${episodeNumber}/poster`, filePath,
                mimeType: row.poster_mime_type || "image/jpeg", source: "episode" };
        }
    }
    const shared = getSharedMerlinPoster();
    return shared ? { ...shared, source: "shared" } : null;
}

function resolveMoviePosterUrl(row) {
    const title = [row.title, row.original_title, row.hausa_title].filter(Boolean).join(" ");
    const episode = title.match(/\b(?:merlin|marlin|malin)\b.*?\b(?:season\s*0?1|s01)\b.*?\b(?:episode|ep)\s*0?(\d{1,2})\b/i) ||
        title.match(/\b(?:merlin|marlin|malin)\b.*?\bs01e0?(\d{1,2})\b/i);
    const number = Number(episode?.[1]);
    if (Number.isInteger(number) && number >= 1 && number <= 10) {
        const poster = getMerlinEpisodePoster(number);
        if (poster?.source === "episode") return poster.url;
        if (poster?.source === "shared") return poster.url;
    }
    return row.poster_path || null;
}

seedLegacyMovies();

module.exports = { database, rowToMovie, getSharedMerlinPoster, getMerlinEpisodePoster, resolveMoviePosterUrl };
