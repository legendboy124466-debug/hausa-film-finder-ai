const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
}
const { loadFileSecrets, configureProxyTrust, validateProductionAdminSecrets } = require("./runtime-config");
loadFileSecrets();

const express = require("express");
const multer = require("multer");
const { createAdminSessionStore } = require("./admin-sessions");
const { database, rowToMovie, getSharedMerlinPoster, getMerlinEpisodePoster } = require("./database");
const { enqueueJob, resumeInterruptedJobs, retryJob, verifyFingerprints } = require("./processor");
const {
    probeMedia,
    probeAudio,
    createImageFingerprintFromFile,
    createSampleFingerprints,
    ensureChromePlayback
} = require("./media");
const { createSocialRoutes, notifyStudioFollowers, cleanupSocialUpload } = require("./social");
const { isTrustedOrigin, isCrossSiteAppRequest } = require("./app-origins");
const merlinEpisodeNumberFromFilename = require("../admin/merlin-episode");
const { getAIResponse, formatAIResponse, sanitizePrompt } = "./ai";
const { loadUsers, hashPassword, validatePassword, generateSessionId, createSession, getSession, invalidateSession, checkRateLimit } = "./users";
const {
    imageMatch,
    visualVideoMatch,
    audioMatch,
    combineVideoAndAudio,
    result,
    IMAGE_THRESHOLD,
    AUDIO_THRESHOLD,
    VIDEO_THRESHOLD,
    AUDIO_VIDEO_THRESHOLD
} = require("./matching");

const uploadsRoot = path.join(root, "uploads");
const movieUploads = path.resolve(process.env.MOVIE_UPLOAD_DIR || path.join(uploadsRoot, "movies"));
const posterUploads = path.resolve(process.env.POSTER_UPLOAD_DIR || path.join(uploadsRoot, "posters"));
const sampleUploads = path.resolve(process.env.SAMPLE_UPLOAD_DIR || path.join(uploadsRoot, "samples"));
const merlinUploads = path.resolve(process.env.MERLIN_UPLOAD_DIR || path.join(uploadsRoot, "merlin"));
const merlinMovieUploads = path.resolve(
    process.env.MERLIN_MOVIE_UPLOAD_DIR || path.join(uploadsRoot, "movies", "merlin")
);
for (const directory of [movieUploads, posterUploads, sampleUploads, merlinUploads, merlinMovieUploads]) {
    fs.mkdirSync(directory, { recursive: true });
}

const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES || 150 * 1024 * 1024); // 150 MB max for short video clips
const videoExtensions = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v", ".mpg", ".mpeg"]);
const audioExtensions = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus", ".webm"]);
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp"]);
const rateLimits = new Map();
const nativeAdminSessions = createAdminSessionStore();

function safeEqualText(left, right) {
    const leftHash = crypto.createHash("sha256").update(String(left)).digest();
    const rightHash = crypto.createHash("sha256").update(String(right)).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function setSessionCookie(response, token, request) {
    const crossSite = isCrossSiteAppRequest(request);
    const secure = crossSite || process.env.NODE_ENV === "production" ? "; Secure" : "";
    const sameSite = crossSite ? "None" : "Strict";
    response.setHeader(
        "Set-Cookie",
        `hf_admin=${token}; Path=/api/admin; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=28800`
    );
}

function createSessionToken(username) {
    const secret = process.env.SESSION_SECRET;
    const payload = Buffer.from(JSON.stringify({
        username,
        expiresAt: Date.now() + 8 * 60 * 60 * 1000
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function verifySessionToken(token) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || typeof token !== "string") return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (!safeEqualText(signature, expected)) return null;
    try {
        const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (typeof session.username !== "string" || session.expiresAt < Date.now()) return null;
        return session;
    } catch {
        return null;
    }
}

function adminReady() {
    return Boolean(
        process.env.ADMIN_USERNAME &&
        process.env.ADMIN_PASSWORD &&
        process.env.ADMIN_PASSWORD.length >= 12 &&
        process.env.SESSION_SECRET &&
        process.env.SESSION_SECRET.length >= 32
    );
}

function requireAdmin(request, response, next) {
    const authorization = request.get("authorization") || "";
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    let session;
    if (authorization) {
        session = bearer ? nativeAdminSessions.verify(bearer[1]) : null;
    } else {
        const cookieToken = request.headers.cookie?.split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith("hf_admin="))
            ?.slice("hf_admin=".length);
        session = verifySessionToken(cookieToken);
    }
    if (!session || !safeEqualText(session.username, process.env.ADMIN_USERNAME || "")) {
        response.status(401).json({ error: "Dole ne mai gudanarwa ya fara shiga." });
        return;
    }
    request.admin = session;
    next();
}

function sameOrigin(request, response, next) {
    const origin = request.get("origin");
    if (!origin) return next();
    if (!isTrustedOrigin(origin, request.get("host"))) {
        response.status(403).json({ error: "Origin ɗin buƙatar bai inganta ba." });
        return;
    }
    next();
}

function rateLimitLogin(request, response, next) {
    const now = Date.now();
    const key = request.ip || request.socket.remoteAddress || "unknown";
    const entry = rateLimits.get(key) || { attempts: 0, resetAt: now + 15 * 60 * 1000 };
    if (entry.resetAt <= now) {
        entry.attempts = 0;
        entry.resetAt = now + 15 * 60 * 1000;
    }
    if (entry.attempts >= 8) {
        response.status(429).json({ error: "An yi yawan ƙoƙarin shiga. Jira kafin sake gwadawa." });
        return;
    }
    entry.attempts += 1;
    rateLimits.set(key, entry);
    next();
}

function createStorage(destinationForFile) {
    return multer.diskStorage({
        destination(request, file, callback) {
            callback(null, destinationForFile(file));
        },
        filename(request, file, callback) {
            callback(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`);
        }
    });
}

function mediaFileFilter(allowedExtensions, expectedMimePrefixes) {
    return (request, file, callback) => {
        const extension = path.extname(file.originalname).toLowerCase();
        const mimeOkay = expectedMimePrefixes.some((prefix) => file.mimetype.startsWith(prefix));
        if (!allowedExtensions.has(extension) || !mimeOkay) {
            callback(new Error("Nau'in fayil ɗin da aka tura ba ya cikin waɗanda aka amince da su."));
            return;
        }
        callback(null, true);
    };
}

const movieUpload = multer({
    storage: createStorage((file) => file.fieldname === "poster" ? posterUploads : movieUploads),
    limits: { fileSize: maxUploadBytes, files: 2, fields: 12, fieldSize: 64 * 1024 },
    fileFilter(request, file, callback) {
        const extensions = file.fieldname === "poster" ? imageExtensions : videoExtensions;
        const mimeTypes = file.fieldname === "poster" ? ["image/"] : ["video/", "application/octet-stream"];
        mediaFileFilter(extensions, mimeTypes)(request, file, callback);
    }
});

const sampleUpload = multer({
    storage: createStorage(() => sampleUploads),
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    fileFilter(request, file, callback) {
        const allowed = request.path.endsWith("/image")
            ? imageExtensions
            : request.path.endsWith("/audio")
                ? audioExtensions
                : new Set([...videoExtensions, ...audioExtensions]);
        const mimeTypes = request.path.endsWith("/image")
            ? ["image/"]
            : request.path.endsWith("/audio")
                ? ["audio/", "application/octet-stream"]
                : ["video/", "audio/", "application/octet-stream"];
        mediaFileFilter(allowed, mimeTypes)(request, file, callback);
    }
});

const merlinVideoUpload = multer({
    storage: createStorage(() => merlinUploads),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 2, fieldSize: 6 * 1024 },
    fileFilter(request, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowed = file.fieldname === "video" && videoExtensions.has(extension) &&
            (file.mimetype.startsWith("video/") || file.mimetype === "application/octet-stream");
        if (!allowed) {
            callback(new Error("Nau'in bidiyon Merlin bai inganta ba."));
            return;
        }
        callback(null, true);
    }
});

const merlinMovieUpload = multer({
    storage: createStorage(() => merlinMovieUploads),
    // episode, season, studio, year, language, actors, and permission confirmation
    limits: { fileSize: maxUploadBytes, files: 1, fields: 7, fieldSize: 6 * 1024 },
    fileFilter(request, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();
        const allowed = file.fieldname === "movie" && videoExtensions.has(extension) &&
            (file.mimetype.startsWith("video/") || file.mimetype === "application/octet-stream");
        if (!allowed) {
            callback(new Error("Nau'in bidiyon Merlin bai inganta ba."));
            return;
        }
        callback(null, true);
    }
});

const merlinPosterUpload = multer({
    storage: createStorage(() => merlinUploads),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter(request, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();
        if (file.fieldname !== "poster" || !imageExtensions.has(extension) ||
            !file.mimetype.startsWith("image/")) {
            callback(new Error("Nau'in poster na Merlin bai inganta ba."));
            return;
        }
        callback(null, true);
    }
});

function merlinEpisodeNumber(request, response, next) {
    if (!/^(?:[1-9]|10)$/.test(request.params.episode)) {
        response.status(404).json({ error: "Ba a sami wannan episode na Merlin ba." });
        return;
    }
    request.merlinEpisodeNumber = Number(request.params.episode);
    next();
}

function merlinFileMimeType(file) {
    if (file.mimetype !== "application/octet-stream") return file.mimetype;
    return {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".avi": "video/x-msvideo",
        ".mpg": "video/mpeg",
        ".mpeg": "video/mpeg"
    }[path.extname(file.originalname).toLowerCase()] || "application/octet-stream";
}

function movieFileMimeType(filePath) {
    return {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".webm": "video/webm",
        ".avi": "video/x-msvideo",
        ".mpg": "video/mpeg",
        ".mpeg": "video/mpeg"
    }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function streamMovie(request, response, filePath, next) {
    const fileSize = fs.statSync(filePath).size;
    const range = request.headers.range;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", movieFileMimeType(filePath));
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");

    if (!range) {
        response.setHeader("Content-Length", fileSize);
        fs.createReadStream(filePath).on("error", next).pipe(response);
        return;
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
        response.setHeader("Content-Range", `bytes */${fileSize}`);
        response.status(416).end();
        return;
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, fileSize - Number(match[2]));
    let end = match[2] && match[1] ? Number(match[2]) : fileSize - 1;
    if (!match[1] && match[2]) end = fileSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= fileSize) {
        response.setHeader("Content-Range", `bytes */${fileSize}`);
        response.status(416).end();
        return;
    }
    end = Math.min(end, fileSize - 1);
    response.status(206);
    response.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    response.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(filePath, { start, end }).on("error", next).pipe(response);
}

function removeMerlinFile(filename) {
    if (!filename) return;
    const filePath = path.resolve(merlinUploads, path.basename(filename));
    if (path.dirname(filePath) !== merlinUploads) {
        throw new Error("Hanyar fayil ɗin Merlin ba ta inganta ba.");
    }
    fs.rmSync(filePath, { force: true });
}

function removeUploadedFiles(files) {
    if (!files) return;
    for (const entries of Object.values(files)) {
        for (const file of entries) fs.rmSync(file.path, { force: true });
    }
}

function hashFileSha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

function isWithinDirectory(filePath, directory) {
    const relativePath = path.relative(directory, filePath);
    return relativePath !== "" && !path.isAbsolute(relativePath) &&
        relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`);
}

function merlinMovieEpisodeFromFilename(filename) {
    return merlinEpisodeNumberFromFilename(filename);
}

function removeSample(filePath) {
    if (filePath) fs.rmSync(filePath, { force: true });
}

function addStudioIfMissing(name) {
    const normalized = name.trim();
    database.prepare(`
        INSERT OR IGNORE INTO studios (id, name, permission_status, created_at)
        VALUES (?, ?, 'unverified', ?)
    `).run(crypto.randomUUID(), normalized, new Date().toISOString());
}

function movieQuery(sql, ...params) {
    return database.prepare(sql).all(...params).map((row) => rowToMovie({
        ...row,
        processing_status: verifiedProcessingStatus(
            row.id,
            row.processing_status,
            Boolean(row.has_audio)
        )
    }));
}

function verifiedProcessingStatus(movieId, status, hasAudio) {
    if (status !== "completed") return status;
    const job = database.prepare(`
        SELECT total_segments FROM processing_jobs
        WHERE movie_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(movieId);
    return job && verifyFingerprints(movieId, job.total_segments, hasAudio)
        ? "completed"
        : "failed";
}

function merlinEpisodePayload(row) {
    const episode = row.episode_number;
    const poster = getMerlinEpisodePoster(episode);
    return {
        episodeNumber: episode,
        title: row.title,
        description: row.description,
        hasVideo: Boolean(row.video_filename),
        videoUrl: row.video_filename ? `/api/merlin/${episode}/video` : null,
        posterUrl: poster?.url || null,
        episodePosterUrl: poster?.source === "episode" ? poster.url : null,
        posterSource: poster?.source || null
    };
}

function registerMerlinEpisodeVideo(episodeNumber, filename, mimeType, updatedAt) {
    if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 10 ||
        typeof filename !== "string" || !filename || path.basename(filename) !== filename ||
        typeof mimeType !== "string" || !mimeType) {
        throw new TypeError("Merlin episode video details are invalid.");
    }
    const result = database.prepare(`
        UPDATE merlin_episodes SET video_filename = ?, video_mime_type = ?, updated_at = ?
        WHERE episode_number = ? AND video_filename IS NULL
    `).run(filename, mimeType, updatedAt, episodeNumber);
    if (result.changes !== 1) {
        throw new Error(`Merlin episode ${episodeNumber} is missing or already has a video.`);
    }
}

function createApp() {
    const app = express();
    configureProxyTrust(app);
    app.disable("x-powered-by");
    app.use((request, response, next) => {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        response.setHeader("X-Frame-Options", "DENY");
        next();
    });
    app.use((request, response, next) => {
        const origin = request.get("origin");
        if (!origin) return next();
        if (!isTrustedOrigin(origin, request.get("host"))) {
            if (request.method === "OPTIONS") {
                response.status(403).end();
                return;
            }
            next();
            return;
        }

        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Allow-Credentials", "true");
        response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
        response.setHeader("Vary", "Origin");
        if (request.method === "OPTIONS") {
            const requestedHeaders = (request.get("access-control-request-headers") || "")
                .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
            const allowedHeaders = new Set(["content-type", "range", "authorization"]);
            if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
                response.status(403).end();
                return;
            }
            response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
            response.setHeader("Access-Control-Allow-Headers", requestedHeaders.join(", "));
            response.setHeader("Access-Control-Max-Age", "600");
            response.status(204).end();
            return;
        }
        next();
    });
    app.use(express.json({ limit: "1mb" }));

    app.get("/api/health", (request, response) => {
        response.json({ status: "ok", database: "sqlite", recognition: "requires-media-tools" });
    });

    app.get("/api/movies", (request, response) => {
        const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
        const rows = query
            ? movieQuery(`
                SELECT m.*, (SELECT status FROM processing_jobs WHERE movie_id = m.id
                    ORDER BY created_at DESC LIMIT 1) AS processing_status
                FROM movies m WHERE m.permission_confirmed = 1
                    AND (m.title LIKE ? OR m.original_title LIKE ? OR m.hausa_title LIKE ? OR
                        m.studio LIKE ? OR m.language LIKE ? OR m.actors_json LIKE ?)
                ORDER BY m.created_at DESC
            `, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`, `%${query}%`)
            : movieQuery(`
                SELECT m.*, (SELECT status FROM processing_jobs WHERE movie_id = m.id
                    ORDER BY created_at DESC LIMIT 1) AS processing_status
                FROM movies m WHERE m.permission_confirmed = 1
                ORDER BY m.created_at DESC
            `);
        response.json({ movies: rows });
    });

    app.get("/api/movies/:id", (request, response) => {
        const row = database.prepare(`
            SELECT m.*, (SELECT status FROM processing_jobs WHERE movie_id = m.id
                ORDER BY created_at DESC LIMIT 1) AS processing_status
            FROM movies m WHERE m.id = ? AND m.permission_confirmed = 1
        `).get(request.params.id);
        if (!row) {
            response.status(404).json({ error: "Ba a sami fim ɗin ba." });
            return;
        }
        response.json({
            movie: rowToMovie({
                ...row,
                processing_status: verifiedProcessingStatus(
                    row.id,
                    row.processing_status,
                    Boolean(row.has_audio)
                )
            })
        });
    });

    app.get("/api/movies/:id/video", async (request, response, next) => {
        const movie = database.prepare(`
            SELECT movie_path FROM movies
            WHERE id = ? AND permission_confirmed = 1
        `).get(request.params.id);
        if (!movie?.movie_path) {
            response.status(404).json({ error: "Ba a sami bidiyon fim ɗin ba." });
            return;
        }
        const filePath = path.resolve(movie.movie_path);
        const storedMovie = [movieUploads, merlinMovieUploads]
            .some((directory) => isWithinDirectory(filePath, directory));
        if (!storedMovie ||
            !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.status(404).json({ error: "Fayil ɗin bidiyon fim ɗin ba ya nan." });
            return;
        }
        const playbackPath = await ensureChromePlayback(filePath);
        streamMovie(request, response, playbackPath, next);
    });

    app.get("/api/studios", (request, response) => {
        const studios = database.prepare(`
            SELECT id, name, permission_status AS permissionStatus
            FROM studios ORDER BY name
        `).all();
        response.json({ studios });
    });

    app.get("/api/merlin", (request, response) => {
        const episodes = database.prepare(`
            SELECT episode_number, title, description, video_filename, poster_filename
            FROM merlin_episodes ORDER BY episode_number
        `).all().map(merlinEpisodePayload);
        response.json({ episodes });
    });

    app.get("/api/merlin/:episode/video", merlinEpisodeNumber, async (request, response, next) => {
        const episode = database.prepare(`
            SELECT video_filename, video_mime_type FROM merlin_episodes
            WHERE episode_number = ?
        `).get(request.merlinEpisodeNumber);
        if (!episode?.video_filename) {
            response.status(404).json({ error: "Ba a ɗora bidiyon wannan episode ba tukuna." });
            return;
        }
        const filePath = [merlinUploads, merlinMovieUploads]
            .map((directory) => path.resolve(directory, path.basename(episode.video_filename)))
            .find((candidate) =>
                [merlinUploads, merlinMovieUploads].some((directory) =>
                    isWithinDirectory(candidate, directory)) &&
                fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            );
        if (!filePath) {
            response.status(404).json({ error: "Fayil ɗin bidiyon Merlin ba ya nan." });
            return;
        }
        const playbackPath = await ensureChromePlayback(filePath);
        streamMovie(request, response, playbackPath, next);
    });

    app.get("/api/merlin/:episode/poster", merlinEpisodeNumber, (request, response, next) => {
        const poster = getMerlinEpisodePoster(request.merlinEpisodeNumber);
        if (!poster) {
            response.status(404).json({ error: "Poster is unavailable." });
            return;
        }
        response.setHeader("Content-Type", poster.mimeType);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.sendFile(poster.filePath, (error) => {
            if (error && !response.headersSent) next(error);
        });
    });

    createSocialRoutes(app, {
        sameOrigin,
        requireAdmin,
        storagePaths: { root, movieUploads, posterUploads, merlinUploads }
    });

    app.post("/api/admin/login", sameOrigin, rateLimitLogin, (request, response) => {
        if (!adminReady()) {
            response.status(503).json({
                error: "Ba a saita ADMIN_USERNAME, kalmar sirri mai ƙarfi, da SESSION_SECRET ba."
            });
            return;
        }
        const username = typeof request.body?.username === "string" ? request.body.username : "";
        const password = typeof request.body?.password === "string" ? request.body.password : "";
        if (!safeEqualText(username, process.env.ADMIN_USERNAME) ||
            !safeEqualText(password, process.env.ADMIN_PASSWORD)) {
            response.status(401).json({ error: "Sunan mai amfani ko kalmar sirri ba daidai ba ce." });
            return;
        }
        // A verified login clears only this client's failed-attempt counter.
        const rateLimitKey = request.ip || request.socket.remoteAddress || "unknown";
        rateLimits.delete(rateLimitKey);
        if (isCrossSiteAppRequest(request)) {
            const session = nativeAdminSessions.issue(username);
            response.json({
                authenticated: true,
                accessToken: session.token,
                expiresAt: session.expiresAt
            });
            return;
        }
        setSessionCookie(response, createSessionToken(username), request);
        response.json({ authenticated: true });
    });

    app.get("/api/admin/me", requireAdmin, (request, response) => {
        response.json({ authenticated: true, username: request.admin.username });
    });

    app.post("/api/admin/logout", sameOrigin, requireAdmin, (request, response) => {
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.get("authorization") || "");
        if (bearer) {
            nativeAdminSessions.revoke(bearer[1]);
        } else {
            const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
            response.setHeader("Set-Cookie", `hf_admin=; Path=/api/admin; HttpOnly; SameSite=Strict${secure}; Max-Age=0`);
        }
        response.json({ authenticated: false });
    });

    app.get("/api/admin/studios", requireAdmin, (request, response) => {
        response.json({
            studios: database.prepare("SELECT * FROM studios ORDER BY name").all()
        });
    });

    app.post("/api/admin/studios", sameOrigin, requireAdmin, (request, response) => {
        const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
        const permissionStatus = request.body?.permissionStatus;
        if (!name || name.length > 200 ||
            !["unverified", "pending", "verified", "not-authorized"].includes(permissionStatus)) {
            response.status(400).json({ error: "Sunan studio ko matsayin izini bai inganta ba." });
            return;
        }
        const links = Array.isArray(request.body.authorizedLinks)
            ? request.body.authorizedLinks.filter((link) => typeof link === "string" && link.length <= 2048).slice(0, 20)
            : [];
        const id = crypto.randomUUID();
        try {
            database.prepare(`
                INSERT INTO studios (id, name, permission_status, authorized_links_json, created_at)
                VALUES (?, ?, ?, ?, ?)
            `).run(id, name, permissionStatus, JSON.stringify(links), new Date().toISOString());
        } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
                response.status(409).json({ error: "An riga an yi rijistar wannan studio." });
                return;
            }
            throw error;
        }
        response.status(201).json({ studio: { id, name, permissionStatus, authorizedLinks: links } });
    });

    app.get("/api/admin/movies", requireAdmin, (request, response) => {
        const movies = movieQuery(`
            SELECT m.*, (SELECT status FROM processing_jobs WHERE movie_id = m.id
                ORDER BY created_at DESC LIMIT 1) AS processing_status
            FROM movies m ORDER BY m.created_at DESC
        `);
        response.json({ movies });
    });

    app.patch("/api/admin/movies/:id", sameOrigin, requireAdmin, (request, response) => {
        const movie = database.prepare("SELECT id FROM movies WHERE id = ?").get(request.params.id);
        if (!movie) {
            response.status(404).json({ error: "Ba a sami fim ɗin ba." });
            return;
        }
        const body = request.body || {};
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const hausaTitle = typeof body.hausaTitle === "string" ? body.hausaTitle.trim() : "";
        const language = typeof body.language === "string" ? body.language.trim() : "";
        const actors = Array.isArray(body.actors) ? body.actors : [];
        const studio = typeof body.studio === "string" ? body.studio.trim() : "";
        const country = typeof body.country === "string" ? body.country.trim() : "";
        const description = typeof body.description === "string" ? body.description.trim() : "";
        const year = body.year === null || body.year === "" ? null : Number(body.year);
        const categories = Array.isArray(body.categories) ? body.categories : [];
        const episodes = Array.isArray(body.episodes) ? body.episodes : [];
        const validEpisodes = episodes.length <= 20 && episodes.every((episode) =>
            episode && Number.isInteger(episode.seasonNumber) && episode.seasonNumber >= 1 &&
            episode.seasonNumber <= 999 && Number.isInteger(episode.episodeNumber) &&
            episode.episodeNumber >= 1 && episode.episodeNumber <= 999
        );
        if (!title || title.length > 200 || hausaTitle.length > 200 || language.length > 100 ||
            actors.length > 100 || actors.some((actor) => typeof actor !== "string" || actor.trim().length > 120) ||
            !studio || studio.length > 200 ||
            country.length > 100 || description.length > 5000 ||
            (year !== null && (!Number.isInteger(year) || year < 1888 || year > 2100)) ||
            categories.length > 20 || categories.some((item) => typeof item !== "string" || item.length > 80) ||
            !validEpisodes) {
            response.status(400).json({ error: "Duba taken fim, studio, shekarar fitarwa, rukuni, da bayanan season/episode." });
            return;
        }
        database.prepare(`
            UPDATE movies SET title = ?, original_title = ?, hausa_title = ?, language = ?, actors_json = ?,
                description = ?, country = ?, year = ?, studio = ?, categories_json = ?, episodes_json = ?, updated_at = ?
            WHERE id = ?
        `).run(
            title, title, hausaTitle, language,
            JSON.stringify(actors.map((actor) => actor.trim()).filter(Boolean)),
            description, country, year, studio,
            JSON.stringify(categories.map((item) => item.trim()).filter(Boolean)),
            JSON.stringify(episodes), new Date().toISOString(), request.params.id
        );
        addStudioIfMissing(studio);
        response.json({ updated: true });
    });

    app.delete("/api/admin/movies/:id", sameOrigin, requireAdmin, (request, response) => {
        const movie = database.prepare(`
            SELECT id, movie_path, poster_filename FROM movies WHERE id = ?
        `).get(request.params.id);
        if (!movie) {
            response.status(404).json({ error: "Ba a sami fim ɗin ba." });
            return;
        }
        const activeJob = database.prepare(`
            SELECT 1 AS active FROM processing_jobs
            WHERE movie_id = ? AND status IN ('waiting', 'processing')
        `).get(movie.id);
        if (activeJob) {
            response.status(409).json({ error: "Dakatar da aikin fingerprint ko jira ya ƙare kafin a cire wannan fim." });
            return;
        }

        const managedMoviePath = movie.movie_path && [movieUploads, merlinMovieUploads]
            .some((directory) => isWithinDirectory(path.resolve(movie.movie_path), directory))
            ? path.resolve(movie.movie_path)
            : null;
        const managedPosterPath = movie.poster_filename
            ? path.resolve(posterUploads, path.basename(movie.poster_filename))
            : null;
        database.exec("BEGIN IMMEDIATE");
        try {
            database.prepare("DELETE FROM merlin_movie_uploads WHERE movie_id = ?").run(movie.id);
            database.prepare("DELETE FROM fingerprints WHERE movie_id = ?").run(movie.id);
            database.prepare("DELETE FROM segments WHERE movie_id = ?").run(movie.id);
            database.prepare("DELETE FROM processing_jobs WHERE movie_id = ?").run(movie.id);
            database.prepare(`
                UPDATE merlin_episodes SET video_filename = NULL, video_mime_type = NULL,
                    updated_at = ? WHERE video_filename = ?
            `).run(new Date().toISOString(), managedMoviePath ? path.basename(managedMoviePath) : "");
            database.prepare("DELETE FROM movies WHERE id = ?").run(movie.id);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        if (managedMoviePath) {
            fs.rmSync(managedMoviePath, { force: true });
            fs.rmSync(`${managedMoviePath}.chrome.mp4`, { force: true });
        }
        if (managedPosterPath && path.dirname(managedPosterPath) === posterUploads) {
            fs.rmSync(managedPosterPath, { force: true });
        }
        response.json({ deleted: true });
    });

    app.get("/api/admin/merlin", requireAdmin, (request, response) => {
        const episodes = database.prepare(`
            SELECT episode_number, title, description, video_filename, poster_filename,
                updated_at
            FROM merlin_episodes ORDER BY episode_number
        `).all().map((row) => ({
            ...merlinEpisodePayload(row),
            updatedAt: row.updated_at
        }));
        response.json({ episodes });
    });

    app.put("/api/admin/merlin/:episode", sameOrigin, requireAdmin, merlinEpisodeNumber,
        merlinVideoUpload.single("video"), (request, response) => {
            const episodeNumber = request.merlinEpisodeNumber;
            const existing = database.prepare(`
                SELECT * FROM merlin_episodes WHERE episode_number = ?
            `).get(episodeNumber);
            const videoFile = request.file;
            const title = typeof request.body.title === "string"
                ? request.body.title.trim()
                : existing?.title;
            const description = typeof request.body.description === "string"
                ? request.body.description.trim()
                : existing?.description;
            if (!existing || !title || title.length > 200 ||
                typeof description !== "string" || description.length > 5000) {
                removeUploadedFiles({ video: videoFile ? [videoFile] : [] });
                response.status(existing ? 400 : 404).json({
                    error: existing
                        ? "Sunan episode ko bayaninsa bai inganta ba."
                        : "Ba a sami wannan episode na Merlin ba."
                });
                return;
            }

            const videoFilename = videoFile?.filename || existing.video_filename;
            const videoMimeType = videoFile ? merlinFileMimeType(videoFile) : existing.video_mime_type;
            try {
                database.prepare(`
                    UPDATE merlin_episodes SET title = ?, description = ?, video_filename = ?,
                        video_mime_type = ?, updated_at = ?
                    WHERE episode_number = ?
                `).run(
                    title, description, videoFilename, videoMimeType,
                    new Date().toISOString(), episodeNumber
                );
            } catch (error) {
                removeUploadedFiles({ video: videoFile ? [videoFile] : [] });
                throw error;
            }

            if (videoFile && existing.video_filename) removeMerlinFile(existing.video_filename);
            response.json({
                episode: merlinEpisodePayload({
                    episode_number: episodeNumber,
                    title,
                    description,
                    video_filename: videoFilename,
                    poster_filename: existing.poster_filename
                })
            });
        });

    app.put("/api/admin/merlin/:episode/poster", sameOrigin, requireAdmin, merlinEpisodeNumber,
        merlinPosterUpload.single("poster"), (request, response) => {
            const existing = database.prepare(`
                SELECT * FROM merlin_episodes WHERE episode_number = ?
            `).get(request.merlinEpisodeNumber);
            if (!existing) {
                if (request.file) removeMerlinFile(request.file.filename);
                response.status(404).json({ error: "Ba a sami wannan episode na Merlin ba." });
                return;
            }
            if (!request.file) {
                response.status(400).json({ error: "Zaɓi poster na wannan episode." });
                return;
            }
            try {
                database.prepare(`
                    UPDATE merlin_episodes SET poster_filename = ?, poster_mime_type = ?,
                        updated_at = ? WHERE episode_number = ?
                `).run(
                    request.file.filename, request.file.mimetype,
                    new Date().toISOString(), request.merlinEpisodeNumber
                );
            } catch (error) {
                removeMerlinFile(request.file.filename);
                throw error;
            }
            if (existing.poster_filename) removeMerlinFile(existing.poster_filename);
            response.json({
                episode: merlinEpisodePayload({
                    ...existing,
                    poster_filename: request.file.filename
                })
            });
        });

    app.delete("/api/admin/merlin/:episode/video", sameOrigin, requireAdmin, merlinEpisodeNumber,
        (request, response) => {
            const episode = database.prepare(`
                SELECT video_filename FROM merlin_episodes WHERE episode_number = ?
            `).get(request.merlinEpisodeNumber);
            if (!episode?.video_filename) {
                response.status(404).json({ error: "Babu bidiyon da za a cire daga wannan slot." });
                return;
            }
            database.prepare(`
                UPDATE merlin_episodes SET video_filename = NULL, video_mime_type = NULL,
                    updated_at = ? WHERE episode_number = ?
            `).run(new Date().toISOString(), request.merlinEpisodeNumber);
            removeMerlinFile(episode.video_filename);
            response.json({ episodeNumber: request.merlinEpisodeNumber, hasVideo: false });
        });

    app.post("/api/admin/movies/:id/permission", sameOrigin, requireAdmin, (request, response) => {
        if (request.body?.permissionConfirmed !== true) {
            response.status(400).json({ error: "Dole ne a tabbatar da izinin wannan kayan fim." });
            return;
        }
        const movie = database.prepare(`
            SELECT id, title, studio, permission_confirmed AS permissionConfirmed
            FROM movies WHERE id = ?
        `).get(request.params.id);
        if (!movie) {
            response.status(404).json({ error: "Ba a sami fim ɗin ba." });
            return;
        }
        const update = database.prepare(`
            UPDATE movies SET permission_confirmed = 1, updated_at = ? WHERE id = ?
        `).run(new Date().toISOString(), request.params.id);
        if (!movie.permissionConfirmed) notifyStudioFollowers(movie.studio, movie.id, movie.title);
        response.json({ permissionConfirmed: true });
    });

    app.post("/api/admin/merlin-movies", sameOrigin, requireAdmin,
        merlinMovieUpload.single("movie"), async (request, response, next) => {
            const file = request.file;
            if (!file) {
                response.status(400).json({ error: "Zaɓi bidiyon Merlin da za a loda." });
                return;
            }

            let registered = false;
            try {
                const episodeNumber = Number(request.body.episodeNumber);
                const seasonNumber = Number(request.body.seasonNumber || 1);
                const studio = typeof request.body.studio === "string" ? request.body.studio.trim() : "";
                const language = typeof request.body.language === "string" ? request.body.language.trim() : "";
                const actors = typeof request.body.actors === "string"
                    ? request.body.actors.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100)
                    : [];
                const year = request.body.year ? Number(request.body.year) : null;
                const permissionConfirmed = request.body.permissionConfirmed === "true";
                const filenameEpisode = merlinMovieEpisodeFromFilename(file.originalname);
                if (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 10 ||
                    !Number.isInteger(seasonNumber) || seasonNumber < 1 || seasonNumber > 999 ||
                    filenameEpisode !== episodeNumber ||
                    !studio || studio.length > 200 || language.length > 100 ||
                    actors.some((actor) => actor.length > 120) ||
                    (year !== null && (!Number.isInteger(year) || year < 1888 || year > 2100)) ||
                    !permissionConfirmed) {
                    response.status(400).json({
                        error: "Duba lambar episode (1–10), season, studio, shekara, sunan fayil, da tabbatar da izinin amfani."
                    });
                    return;
                }

                const sha256 = await hashFileSha256(file.path);
                const movieTitle = `Merlin Season ${String(seasonNumber).padStart(2, "0")} Episode ${String(episodeNumber).padStart(2, "0")}`;
                const hausaTitle = `Merlin Kashi ${String(episodeNumber).padStart(2, "0")}`;
                const now = new Date().toISOString();
                const movieId = crypto.randomUUID();
                const jobId = crypto.randomUUID();

                database.exec("BEGIN IMMEDIATE");
                let transactionOpen = true;
                try {
                    const priorEpisode = database.prepare(`
                        SELECT m.id, m.title, j.id AS job_id, j.status
                        FROM merlin_movie_uploads u
                        JOIN movies m ON m.id = u.movie_id
                        LEFT JOIN processing_jobs j ON j.movie_id = m.id
                        WHERE u.sha256 = ? OR (u.season_number = ? AND u.episode_number = ?)
                        LIMIT 1
                    `).get(sha256, seasonNumber, episodeNumber);
                    const priorMovie = priorEpisode || database.prepare(`
                        SELECT id, title FROM movies
                        WHERE title = ? COLLATE NOCASE AND studio = ? COLLATE NOCASE
                        LIMIT 1
                    `).get(movieTitle, studio);
                    if (priorMovie) {
                        database.exec("ROLLBACK");
                        transactionOpen = false;
                        fs.rmSync(file.path, { force: true });
                        response.status(409).json({
                            error: `An riga akwai rikodin ${priorMovie.title}; ba a ƙara kwafi ba.`,
                            movieId: priorMovie.id,
                            jobId: priorMovie.job_id || null,
                            status: priorMovie.status || null
                        });
                        return;
                    }

                    const slot = database.prepare(`
                        SELECT poster_filename, video_filename FROM merlin_episodes
                        WHERE episode_number = ?
                    `).get(episodeNumber);
                    if (!slot) throw new Error(`Merlin episode ${episodeNumber} does not exist.`);
                    if (slot.video_filename) {
                        database.exec("ROLLBACK");
                        transactionOpen = false;
                        fs.rmSync(file.path, { force: true });
                        response.status(409).json({
                            error: `Merlin Episode ${String(episodeNumber).padStart(2, "0")} already has a slot video; it was left unchanged.`
                        });
                        return;
                    }
                    database.prepare(`
                        INSERT INTO movies (
                            id, title, original_title, hausa_title, language, actors_json, year, studio,
                            categories_json, episodes_json, movie_path, poster_path,
                            permission_confirmed, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    `).run(
                        movieId,
                        movieTitle,
                        movieTitle,
                        hausaTitle,
                        language,
                        JSON.stringify(actors),
                        year,
                        studio,
                        JSON.stringify(["TV Series", "Hausa Dubbed"]),
                        JSON.stringify([{ seasonNumber, episodeNumber }]),
                        file.path,
                        slot?.poster_filename ? `/api/merlin/${episodeNumber}/poster` : null,
                        now,
                        now
                    );
                    database.prepare(`
                        INSERT INTO merlin_movie_uploads (
                            movie_id, season_number, episode_number, sha256, created_at
                        ) VALUES (?, ?, ?, ?, ?)
                    `).run(movieId, seasonNumber, episodeNumber, sha256, now);
                    addStudioIfMissing(studio);
                    database.prepare(`
                        INSERT INTO processing_jobs (id, movie_id, status, created_at, updated_at)
                        VALUES (?, ?, 'waiting', ?, ?)
                    `).run(jobId, movieId, now, now);
                    registerMerlinEpisodeVideo(
                        episodeNumber,
                        path.basename(file.filename),
                        merlinFileMimeType(file),
                        now
                    );
                    database.exec("COMMIT");
                    transactionOpen = false;
                    registered = true;
                } catch (error) {
                    if (transactionOpen) database.exec("ROLLBACK");
                    throw error;
                }

                notifyStudioFollowers(studio, movieId, movieTitle);
                enqueueJob(jobId);
                response.status(202).json({
                    movieId,
                    jobId,
                    title: movieTitle,
                    episodeNumber,
                    seasonNumber,
                    uploadStatus: "completed",
                    fingerprintStatus: "waiting"
                });
            } catch (error) {
                if (!registered) fs.rmSync(file.path, { force: true });
                next(error);
            }
        });

    app.post("/api/admin/movies", sameOrigin, requireAdmin, movieUpload.fields([
        { name: "movie", maxCount: 1 },
        { name: "poster", maxCount: 1 }
    ]), (request, response) => {
        const uploaded = request.files || {};
        const movieFile = uploaded.movie?.[0];
        const posterFile = uploaded.poster?.[0];
        const title = typeof request.body.title === "string" ? request.body.title.trim() : "";
        const hausaTitle = typeof request.body.hausaTitle === "string" ? request.body.hausaTitle.trim() : "";
        const language = typeof request.body.language === "string" ? request.body.language.trim() : "";
        const actors = typeof request.body.actors === "string"
            ? request.body.actors.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100)
            : [];
        const studio = typeof request.body.studio === "string" ? request.body.studio.trim() : "";
        const country = typeof request.body.country === "string" ? request.body.country.trim() : "";
        const description = typeof request.body.description === "string" ? request.body.description.trim() : "";
        const year = request.body.year ? Number(request.body.year) : null;
        const seasonNumber = request.body.seasonNumber ? Number(request.body.seasonNumber) : null;
        const episodeNumber = request.body.episodeNumber ? Number(request.body.episodeNumber) : null;
        const permissionConfirmed = request.body.permissionConfirmed === "true";
        const categories = typeof request.body.categories === "string"
            ? request.body.categories.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20)
            : [];
        if (!movieFile || !title || title.length > 200 ||
            hausaTitle.length > 200 || language.length > 100 || actors.some((actor) => actor.length > 120) ||
            !studio || studio.length > 200 ||
            country.length > 100 || description.length > 5000 ||
            (year !== null && (!Number.isInteger(year) || year < 1888 || year > 2100)) ||
            (seasonNumber !== null && (!Number.isInteger(seasonNumber) || seasonNumber < 1 || seasonNumber > 999)) ||
            (episodeNumber !== null && (!Number.isInteger(episodeNumber) || episodeNumber < 1 || episodeNumber > 999)) ||
            !permissionConfirmed) {
            removeUploadedFiles(uploaded);
            response.status(400).json({
                error: "Ana buƙatar fayil ɗin fim, suna, studio, da tabbatar da izinin sarrafa fim ɗin. Season ko episode dole su zama lamba daga 1 zuwa 999."
            });
            return;
        }

        const episodes = seasonNumber !== null || episodeNumber !== null
            ? [{ seasonNumber, episodeNumber }]
            : [];
        const movieId = crypto.randomUUID();
        const jobId = crypto.randomUUID();
        const now = new Date().toISOString();
        try {
            database.exec("BEGIN IMMEDIATE");
            const duplicate = database.prepare(`
                SELECT id FROM movies
                WHERE title = ? COLLATE NOCASE
                    AND studio = ? COLLATE NOCASE
                    AND year IS ?
                LIMIT 1
            `).get(title, studio, year);
            if (duplicate) {
                database.exec("ROLLBACK");
                removeUploadedFiles(uploaded);
                response.status(409).json({
                    error: "An riga wannan fim ɗin tare da wannan studio da shekara. Ba a ƙirƙiri wani sabon rikodi ba."
                });
                return;
            }
            database.prepare(`
                INSERT INTO movies (
                    id, title, original_title, hausa_title, language, actors_json, description, country, year, studio,
                    categories_json, episodes_json, movie_path, poster_path, poster_filename,
                    permission_confirmed, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            `).run(
                movieId, title, title, hausaTitle, language, JSON.stringify(actors), description, country, year, studio,
                JSON.stringify(categories), JSON.stringify(episodes), movieFile.path,
                posterFile ? `/uploads/posters/${encodeURIComponent(posterFile.filename)}` : null,
                posterFile?.filename || null, now, now
            );
            addStudioIfMissing(studio);
            database.prepare(`
                INSERT INTO processing_jobs (id, movie_id, status, created_at, updated_at)
                VALUES (?, ?, 'waiting', ?, ?)
            `).run(jobId, movieId, now, now);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            removeUploadedFiles(uploaded);
            throw error;
        }
        notifyStudioFollowers(studio, movieId, title);
        enqueueJob(jobId);
        response.status(202).json({ movieId, jobId, status: "waiting" });
    });

    app.get("/api/admin/jobs", requireAdmin, (request, response) => {
        const jobs = database.prepare(`
            SELECT j.*, m.title, m.hausa_title, m.poster_path, m.has_audio,
                m.episodes_json, m.movie_path
            FROM processing_jobs j JOIN movies m ON m.id = j.movie_id
            ORDER BY j.created_at DESC
        `).all().map((job) => {
            const { episodes_json: episodesJson, movie_path: moviePath, ...publicJob } = job;
            let episodes = [];
            try {
                episodes = JSON.parse(episodesJson || "[]");
            } catch {
                episodes = [];
            }
            const episodeNumber = Number.isInteger(episodes[0]?.episodeNumber)
                ? episodes[0].episodeNumber
                : null;
            const uploadStatus = moviePath && fs.existsSync(moviePath) ? "completed" : "failed";
            if (job.status !== "completed" ||
                verifyFingerprints(job.movie_id, job.total_segments, Boolean(job.has_audio))) {
                return { ...publicJob, episode_number: episodeNumber, upload_status: uploadStatus };
            }
            return {
                ...publicJob,
                episode_number: episodeNumber,
                upload_status: uploadStatus,
                status: "failed",
                processing_stage: "failed",
                error: job.error || "Fingerprint verification failed; this job cannot be marked completed."
            };
        });
        response.json({ jobs });
    });

    app.get("/api/admin/jobs/:id/segments", requireAdmin, (request, response) => {
        const segments = database.prepare(`
            SELECT segment_number AS segmentNumber, start_seconds AS startSeconds,
                end_seconds AS endSeconds, status, attempts, error
            FROM segments WHERE movie_id = (
                SELECT movie_id FROM processing_jobs WHERE id = ?
            ) ORDER BY segment_number
        `).all(request.params.id);
        response.json({ segments });
    });

    app.post("/api/admin/jobs/:id/pause", sameOrigin, requireAdmin, (request, response) => {
        const job = database.prepare("SELECT status FROM processing_jobs WHERE id = ?").get(request.params.id);
        if (!job) {
            response.status(404).json({ error: "Ba a sami aikin ba." });
            return;
        }
        if (job.status === "waiting") {
            database.prepare(`
                UPDATE processing_jobs SET status = 'paused', processing_stage = 'paused',
                    pause_requested = 1, updated_at = ?
                WHERE id = ?
            `).run(new Date().toISOString(), request.params.id);
        } else if (job.status === "processing") {
            database.prepare(`
                UPDATE processing_jobs SET processing_stage = 'pause requested',
                    pause_requested = 1, updated_at = ? WHERE id = ?
            `).run(new Date().toISOString(), request.params.id);
        }
        response.json({ status: job.status === "processing" ? "pause-requested" : "paused" });
    });

    app.post("/api/admin/jobs/:id/resume", sameOrigin, requireAdmin, (request, response) => {
        const job = database.prepare("SELECT id, status FROM processing_jobs WHERE id = ?").get(request.params.id);
        if (!job) {
            response.status(404).json({ error: "Ba a sami aikin ba." });
            return;
        }
        if (!retryJob(request.params.id)) {
            response.status(409).json({ error: "Aikin yana gudana ko ba a dakatar da shi ba; ba a sake saka shi a layi ba." });
            return;
        }
        response.json({ status: "waiting" });
    });

    app.post("/api/identify/image", sampleUpload.single("sample"), async (request, response) => {
        const file = request.file;
        if (!file) {
            response.status(400).json({ error: "Zaɓi hoton da za a kwatanta." });
            return;
        }
        try {
            const hash = await createImageFingerprintFromFile(file.path);
            const candidate = imageMatch(hash);
            response.json(result(candidate, IMAGE_THRESHOLD));
        } catch (error) {
            response.status(503).json({ error: error.message });
        } finally {
            removeSample(file.path);
        }
    });

    app.post("/api/identify/audio", sampleUpload.single("sample"), async (request, response) => {
        const file = request.file;
        if (!file) {
            response.status(400).json({ error: "Zaɓi samfurin sauti da za a kwatanta." });
            return;
        }
        try {
            const media = await probeAudio(file.path);
            if (media.duration > 120) {
                response.status(400).json({ error: "Samfurin sauti ya fi minti biyu. Zaɓi ɗan gajeren ɓangare." });
                return;
            }
            const fingerprint = await require("../fingerprint/audio").createAudioFingerprint(file.path, 120);
            response.json(result(audioMatch(fingerprint.fingerprint), AUDIO_THRESHOLD));
        } catch (error) {
            response.status(503).json({ error: error.message });
        } finally {
            removeSample(file.path);
        }
    });

    app.post("/api/identify/video", sampleUpload.single("sample"), async (request, response) => {
        const file = request.file;
        if (!file) {
            response.status(400).json({ error: "Zaɓi ɗan gajeren bidiyo da za a kwatanta." });
            return;
        }
        try {
            const media = await probeMedia(file.path);
            if (media.duration > 120) {
                response.status(400).json({ error: "Bidiyon nema ya fi minti biyu. Zaɓi ɗan gajeren ɓangare." });
                return;
            }
            const sample = await createSampleFingerprints(file.path, media);
            const visual = visualVideoMatch(sample.visual);
            const audio = sample.audio ? audioMatch(sample.audio.fingerprint) : null;
            const candidate = combineVideoAndAudio(visual, audio);
            const threshold = candidate?.modality === "audio"
                ? AUDIO_THRESHOLD
                : candidate?.modality === "audio+video"
                    ? AUDIO_VIDEO_THRESHOLD
                    : VIDEO_THRESHOLD;
            response.json(result(candidate, threshold));
        } catch (error) {
            response.status(503).json({ error: error.message });
        } finally {
            removeSample(file.path);
        }
    });

    app.get("/legacy-merlin-poster", (request, response) => {
        const poster = getSharedMerlinPoster();
        if (!poster) return response.status(404).end();
        response.type(poster.mimeType).sendFile(poster.filePath);
    });
    app.get("/manifest.webmanifest", (request, response) => {
        response.sendFile(path.join(root, "manifest.webmanifest"));
    });
    app.get("/apple-touch-icon.png", (request, response) => {
        response.sendFile(path.join(root, "assets", "apple-touch-icon.png"));
    });
    app.get("/", (request, response) => response.sendFile(path.join(root, "index.html")));
    app.get("/style.css", (request, response) => response.sendFile(path.join(root, "style.css")));
    app.get("/app.js", (request, response) => response.sendFile(path.join(root, "app.js")));
    app.get("/server-config.js", (request, response) => response.sendFile(path.join(root, "server-config.js")));
    app.get("/social.js", (request, response) => response.sendFile(path.join(root, "social.js")));
    app.get("/merlin-poster.html", (request, response) => response.sendFile(path.join(root, "merlin-poster.html")));
    app.get("/admin", (request, response) => response.sendFile(path.join(root, "admin", "admin.html")));
    app.use("/admin", express.static(path.join(root, "admin"), { index: false, dotfiles: "deny" }));

// Account routes
app.post("/api/account/register", async (request, response) => {
  const { username, password } = request.body;
  if (!username || !password) {
    return response.status(400).json({ error: "Sanan username da kalaKE password ba" });
  }
  if (username.length < 3 || username.length > 50) {
    return response.status(400).json({ error: "Username sunan 3-50 harsuwa" });
  }
  if (password.length < 6 || password.length > 128) {
    return response.status(400).json({ error: "Password sunan 6-128 harsuwa" });
  }

  const users = loadUsers();
  if (users[username]) {
    return response.status(409).json({ error: "Samu da idace da aka samu dan nan username" });
  }

  const passwordHash = hashPassword(password);
  users[username] = {
    id: username,
    username,
    passwordHash,
    role: "user",
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  const sessionId = createSession(username);
  if (!sessionId) {
    return response.status(500).json({ error: "An samu gwada session" });
  }

  setSessionCookie(response, sessionId, request);
  response.json({ success: true, sessionId, role: "user" });
});

app.post("/api/account/login", async (request, response) => {
  const { username, password } = request.body;
  if (!username || !password) {
    return response.status(400).json({ error: "Sanan username da kalaKE password ba" });
  }

  const users = loadUsers();
  if (!users[username]) {
    return response.status(401).json({ error: "Sannan sunan username ba" });
  }

  if (!validatePassword(password, users[username].passwordHash)) {
    return response.status(401).json({ error: "Kalmar sirri babu sami" });
  }

  const sessionId = createSession(username);
  if (!sessionId) {
    return response.status(500).json({ error: "An samu gwada session" });
  }

  setSessionCookie(response, sessionId, request);
  response.json({ success: true, sessionId, role: "user" });
});

app.post("/api/account/logout", (request, response) => {
  const token = request.cookies?.hf_admin;
  if (token) {
    invalidateSession(token);
  }
  response.clearCookie("hf_admin");
  response.json({ success: true });
});

app.get("/api/account/me", (request, response) => {
  const token = request.cookies?.hf_admin;
  if (!token) {
    return response.status(401).json({ error: "Badu da kowa kowa" });
  }

  const session = getSession(token);
  if (!session) {
    return response.status(401).json({ error: "Sannan kowa kowa" });
  }

  response.json({ username: session.username, role: "user" });
});

// Rate limit check endpoint
app.post("/api/account/rate-limit", (request, response) => {
  const token = request.cookies?.hf_admin;
  if (!token) {
    return response.status(401).json({ error: "Badu da kowa kowa" });
  }

  const rate = checkRateLimit(token, 10, 60 * 1000);
  response.json({ allowed: rate.allowed, reset: rate.reset });
});
    app.use("/uploads/posters", express.static(posterUploads, { index: false, dotfiles: "deny" }));
    app.use("/assets", express.static(path.join(root, "assets"), { index: false, dotfiles: "deny" }));
    app.use("/movie-images", express.static(path.join(root, "movie-images"), { index: false, dotfiles: "deny" }));

    app.use((request, response) => {
        response.status(404).json({ error: "Ba a sami hanyar da aka nema ba." });
    });

    app.use((error, request, response, next) => {
        if (response.headersSent) return next(error);
        cleanupSocialUpload(request);
        if (error instanceof multer.MulterError) {
            const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            response.status(status).json({ error: `An ƙi fayil ɗin da aka tura: ${error.message}` });
            return;
        }
        const status = Number.isInteger(error.status) ? error.status : 400;
        if (status >= 500) console.error("Request failed:", error);
        response.status(status).json({
            error: status >= 500
                ? "An samu kuskure a server yayin aiwatar da buƙata."
                : error.message || "An samu kuskure wajen aiwatar da buƙata."
        });
    });
    return app;
}

function startServer() {
    validateProductionAdminSecrets();
    const app = createApp();
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || "0.0.0.0";
    const server = app.listen(port, host, () => {
        console.log(`HAUSA FILM FINDER AI yana sauraro a http://${host}:${port}`);
        resumeInterruptedJobs();
    });
    return server;
}

if (require.main === module) startServer();

module.exports = { createApp, startServer, registerMerlinEpisodeVideo };
