const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const multer = require("multer");
const { database, resolveMoviePosterUrl } = require("./database");

function moviePosterUrl(movieId, fallback = null) {
    if (!movieId) return fallback;
    const movie = database.prepare(`
        SELECT id, title, original_title, hausa_title, poster_path
        FROM movies WHERE id = ?
    `).get(movieId);
    return movie ? resolveMoviePosterUrl(movie) : fallback;
}
const { createMohammadAiRoutes } = require("./mohammad-ai");
const { isCrossSiteAppRequest } = require("./app-origins");

const root = path.resolve(__dirname, "..");
const socialUploads = path.resolve(process.env.SOCIAL_UPLOAD_DIR || path.join(root, "uploads", "social"));
fs.mkdirSync(socialUploads, { recursive: true });

const cookieName = "hf_user";
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const authAttempts = new Map();
const actionAttempts = new Map();
const mediaTypes = new Map([
    ["image/jpeg", ".jpg"],
    ["image/png", ".png"],
    ["image/webp", ".webp"],
    ["audio/webm", ".webm"],
    ["audio/ogg", ".ogg"],
    ["audio/mpeg", ".mp3"],
    ["audio/wav", ".wav"],
    ["audio/mp4", ".m4a"],
    ["application/pdf", ".pdf"]
]);
const reactions = new Set(["ðŸ‘", "â¤ï¸", "ðŸ˜‚", "ðŸ˜®", "ðŸ˜¢", "ðŸŽ¬"]);

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

function validatePhoneNumber(phone) {
    if (typeof phone !== "string") return false;
    const cleaned = phone.replace(/[\s\-\(\)]/g, "");
    // Nigerian numbers: +234XXXXXXXXXX, 234XXXXXXXXXX, 0XXXXXXXXXX (10-11 digits after country code)
    // Also accept international format
    return /^(\+?234|0)[789]\d{9}$/.test(cleaned);
}

function normalizePhoneNumber(phone) {
    if (typeof phone !== "string") return "";
    const cleaned = phone.replace(/[\s\-\(\)]/g, "");
    // Convert to +234 format
    if (cleaned.startsWith("0")) {
        return "+234" + cleaned.slice(1);
    }
    if (cleaned.startsWith("234")) {
        return "+" + cleaned;
    }
    if (cleaned.startsWith("+234")) {
        return cleaned;
    }
    return cleaned;
}

function socialSessionReady() {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
        throw problem(503, "Dole a saita SESSION_SECRET mai tsawo kafin a kunna asusun masu amfani.");
    }
}

function problem(status, message) {
    return new HttpError(status, message);
}

function now() {
    return new Date().toISOString();
}

function boundedText(value, maxLength, label, required = false) {
    const text = typeof value === "string" ? value.trim() : "";
    if ((required && !text) || text.length > maxLength) {
        throw problem(400, `${label} bai inganta ba.`);
    }
    return text;
}

function idFrom(value, label) {
    if (typeof value !== "string" || value.length < 1 || value.length > 100) {
        throw problem(400, `${label} bai inganta ba.`);
    }
    return value;
}

function parseCookie(request, name) {
    const part = request.headers.cookie?.split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith(`${name}=`));
    return part ? part.slice(name.length + 1) : "";
}

function signSession(user) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
        throw problem(503, "Dole a saita SESSION_SECRET mai tsawo kafin a kunna asusun masu amfani.");
    }
    const payload = Buffer.from(JSON.stringify({
        id: user.id,
        version: user.session_version,
        expiresAt: Date.now() + sessionLifetime
    })).toString("base64url");
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}

function verifySession(token) {
    const secret = process.env.SESSION_SECRET;
    if (!secret || typeof token !== "string") return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    const suppliedBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(suppliedBytes, expectedBytes)) return null;
    try {
        const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (typeof session.id !== "string" || !Number.isInteger(session.version) ||
            !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) return null;
        return session;
    } catch {
        return null;
    }
}

function setUserCookie(response, user, request) {
    const crossSite = isCrossSiteAppRequest(request);
    const secure = crossSite || process.env.NODE_ENV === "production" ? "; Secure" : "";
    const sameSite = crossSite ? "None" : "Strict";
    response.setHeader(
        "Set-Cookie",
        `${cookieName}=${signSession(user)}; Path=/api; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=${sessionLifetime / 1000}`
    );
}

function clearUserCookie(response, request) {
    const crossSite = isCrossSiteAppRequest(request);
    const secure = crossSite || process.env.NODE_ENV === "production" ? "; Secure" : "";
    const sameSite = crossSite ? "None" : "Strict";
    response.setHeader(
        "Set-Cookie",
        `${cookieName}=; Path=/api; HttpOnly; SameSite=${sameSite}${secure}; Max-Age=0`
    );
}

function loadSessionUser(request) {
    const session = verifySession(parseCookie(request, cookieName));
    if (!session) return null;
    const user = database.prepare(`
        SELECT u.id, u.username, u.role, u.is_suspended, u.can_create_groups,
            u.session_version, p.full_name, p.photo_media_id, p.bio, p.is_private,
            p.message_policy
        FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = ?
    `).get(session.id);
    if (!user || user.is_suspended || user.session_version !== session.version) return null;
    return user;
}

function requireUser(request, response, next) {
    const user = loadSessionUser(request);
    if (!user) {
        response.status(401).json({ error: "Dole ne ka shiga asusunka." });
        return;
    }
    request.user = user;
    next();
}

function userActionLimit(maximum = 30) {
    return (request, response, next) => {
        const userId = request.user?.id || request.ip || "unknown";
        const key = `${userId}:${request.route?.path || request.path}`;
        const time = Date.now();
        let entry = actionAttempts.get(key);
        if (!entry || entry.resetAt <= time) {
            entry = { count: 0, resetAt: time + 60_000 };
        }
        entry.count += 1;
        actionAttempts.set(key, entry);
        if (entry.count > maximum) {
            response.status(429).json({ error: "An yi yawan buÆ™atu. Jira na É—an lokaci kafin sake gwadawa." });
            return;
        }
        next();
    };
}

function authRateLimit(request, response, next) {
    const key = request.ip || request.socket.remoteAddress || "unknown";
    console.log("[AUTH RATE LIMIT] Key:", key, "Count:", authAttempts.get(key)?.count || 0);
    const time = Date.now();
    let entry = authAttempts.get(key);
    if (!entry || entry.resetAt <= time) entry = { count: 0, resetAt: time + 15 * 60_000 };
    entry.count += 1;
    authAttempts.set(key, entry);
    if (entry.count > 10) {
        response.status(429).json({ error: "An yi yawan Æ™oÆ™arin shiga. Jira kafin sake gwadawa." });
        return;
    }
    next();
}

function attachMediaUpload(imageOnly = false) {
    return multer({
        storage: multer.diskStorage({
            destination(request, file, callback) {
                callback(null, socialUploads);
            },
            filename(request, file, callback) {
                const mime = file.mimetype.split(";")[0].toLowerCase();
                callback(null, `${crypto.randomUUID()}${mediaTypes.get(mime) || ".bin"}`);
            }
        }),
        limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024 },
        fileFilter(request, file, callback) {
            const mime = file.mimetype.split(";")[0].toLowerCase();
            if (!mediaTypes.has(mime) || (imageOnly && !mime.startsWith("image/"))) {
                callback(problem(400, "Nau'in hoton ko fayil É—in ba a amince da shi ba."));
                return;
            }
            callback(null, true);
        }
    });
}

const socialUpload = attachMediaUpload();
const profileUpload = attachMediaUpload(true);

function saveMedia(file, ownerId, purpose, resourceId = null) {
    if (!file) return null;
    const mimeType = file.mimetype.split(";")[0].toLowerCase();
    const mediaId = crypto.randomUUID();
    try {
        database.prepare(`
            INSERT INTO social_media (
                id, owner_id, file_name, original_name, mime_type, size_bytes,
                purpose, resource_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            mediaId,
            ownerId,
            path.basename(file.filename),
            path.basename(file.originalname).slice(0, 200) || "attachment",
            mimeType,
            file.size,
            purpose,
            resourceId,
            now()
        );
    } catch (error) {
        fs.rmSync(file.path, { force: true });
        throw error;
    }
    return mediaId;
}

function removeFile(file) {
    if (file?.path) fs.rmSync(file.path, { force: true });
}

function cleanupSocialUpload(request) {
    const filePath = request.file?.path;
    if (filePath && path.dirname(path.resolve(filePath)) === path.resolve(socialUploads)) {
        fs.rmSync(filePath, { force: true });
    }
}

function userSummary(userId, viewerId = null) {
    const user = database.prepare(`
        SELECT u.id, u.username, u.phone_number, u.role, p.full_name AS fullName, p.bio,
            p.is_private AS isPrivate, p.photo_media_id AS photoMediaId,
            (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS followersCount,
            (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS followingCount,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS isFollowing,
            EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = u.id AND f.following_id = ?) AS followsYou,
            EXISTS(SELECT 1 FROM follow_requests r WHERE r.requester_id = ? AND r.target_id = u.id) AS requestPending,
            EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = u.id) AS blockedByMe
        FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = ?
    `).get(viewerId, viewerId, viewerId, viewerId, userId);
    if (user && userId !== viewerId && !canViewProfile(userId, viewerId)) {
        user.bio = "";
        user.photoMediaId = null;
    }
    return user;
}

function isBlocked(firstId, secondId) {
    return Boolean(database.prepare(`
        SELECT 1 FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?)
            OR (blocker_id = ? AND blocked_id = ?)
    `).get(firstId, secondId, secondId, firstId));
}

function canViewProfile(profileId, viewerId) {
    if (!viewerId) {
        return Boolean(database.prepare(`
            SELECT 1 FROM profiles WHERE user_id = ? AND is_private = 0
        `).get(profileId));
    }
    if (profileId === viewerId) return true;
    if (isBlocked(profileId, viewerId)) return false;
    return Boolean(database.prepare(`
        SELECT 1 FROM profiles p
        WHERE p.user_id = ? AND (
            p.is_private = 0 OR EXISTS (
                SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.user_id
            )
        )
    `).get(profileId, viewerId));
}

function notify(userId, actorId, type, entityId, payload = {}) {
    if (!userId || userId === actorId) return;
    database.prepare(`
        INSERT INTO notifications (id, user_id, actor_id, type, entity_id, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), userId, actorId || null, type, entityId || null, JSON.stringify(payload), now());
}

function notifyStudioFollowers(studioName, movieId, movieTitle) {
    const studio = database.prepare("SELECT id FROM studios WHERE name = ? COLLATE NOCASE").get(studioName);
    if (!studio) return;
    const followers = database.prepare(`
        SELECT user_id FROM user_studio_follows WHERE studio_id = ?
    `).all(studio.id);
    for (const follower of followers) {
        notify(follower.user_id, null, "studio_movie", movieId, {
            studio: studioName,
            title: movieTitle
        });
    }
}

function validateMovie(movieId) {
    if (!movieId) return null;
    const movie = database.prepare(`
        SELECT id, title, poster_path, studio FROM movies
        WHERE id = ? AND permission_confirmed = 1
    `).get(movieId);
    if (!movie) throw problem(400, "ZaÉ“aÉ“É“en fim bai samu amincewar gudanarwa ba.");
    return movie;
}

function validateAuthorizedLink(value) {
    if (!value) return null;
    const link = boundedText(value, 2048, "Hanyar fim");
    let candidate;
    try {
        candidate = new URL(link);
    } catch {
        throw problem(400, "Hanyar fim ba ingantacciyar URL ba ce.");
    }
    if (candidate.protocol !== "https:" || candidate.username || candidate.password) {
        throw problem(400, "Ana karÉ“ar hanyoyin HTTPS da aka amince da su kawai.");
    }
    const studios = database.prepare(`
        SELECT authorized_links_json FROM studios WHERE permission_status = 'verified'
    `).all();
    const allowed = studios.some((studio) => {
        let links;
        try {
            links = JSON.parse(studio.authorized_links_json);
        } catch {
            return false;
        }
        return links.some((entry) => {
            if (typeof entry !== "string") return false;
            try {
                const base = new URL(entry);
                if (base.protocol !== "https:" || base.origin !== candidate.origin) return false;
                const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
                return candidate.pathname === base.pathname ||
                    candidate.pathname.startsWith(prefix);
            } catch {
                return false;
            }
        });
    });
    if (!allowed) throw problem(400, "Hanyar ba ta cikin hanyoyin da aka amince da su na studio.");
    return candidate.href;
}

function accessiblePost(postId, viewerId) {
    return database.prepare(`
        SELECT p.id, p.author_id AS authorId, p.content, p.post_type AS postType,
            p.movie_id AS movieId, p.rating, p.authorized_link AS authorizedLink,
            p.shared_post_id AS sharedPostId, p.attachment_media_id AS attachmentMediaId,
            p.created_at AS createdAt
        FROM posts p JOIN profiles author_profile ON author_profile.user_id = p.author_id
        WHERE p.id = ? AND p.removed_at IS NULL AND NOT EXISTS (
            SELECT 1 FROM blocks b WHERE
                (b.blocker_id = p.author_id AND b.blocked_id = ?) OR
                (b.blocker_id = ? AND b.blocked_id = p.author_id)
        ) AND (
            p.author_id = ? OR author_profile.is_private = 0 OR EXISTS (
                SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.author_id
            )
        )
    `).get(postId, viewerId, viewerId, viewerId, viewerId);
}

function postSummary(row, viewerId) {
    const shared = row.sharedPostId ? database.prepare(`
        SELECT p.id, p.content, p.movie_id AS movieId, m.title AS movieTitle,
            u.username AS username, pr.full_name AS fullName
        FROM posts p JOIN users u ON u.id = p.author_id
        JOIN profiles pr ON pr.user_id = u.id
        LEFT JOIN movies m ON m.id = p.movie_id
        WHERE p.id = ? AND p.removed_at IS NULL AND (
            p.author_id = ? OR pr.is_private = 0 OR EXISTS (
                SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = p.author_id
            )
        ) AND NOT EXISTS (
            SELECT 1 FROM blocks b WHERE
                (b.blocker_id = p.author_id AND b.blocked_id = ?) OR
                (b.blocker_id = ? AND b.blocked_id = p.author_id)
        )
    `).get(row.sharedPostId, viewerId, viewerId, viewerId, viewerId) : null;
    return {
        id: row.id,
        content: row.content,
        type: row.postType,
        movieId: row.movieId,
        movieTitle: row.movieTitle || null,
        posterUrl: moviePosterUrl(row.movieId, row.posterUrl || null),
        rating: row.rating,
        authorizedLink: row.authorizedLink,
        sharedPostId: row.sharedPostId,
        sharedPost: shared,
        createdAt: row.createdAt,
        author: {
            id: row.authorId,
            username: row.username,
            fullName: row.fullName,
            photoUrl: row.photoMediaId ? `/api/social/media/${encodeURIComponent(row.photoMediaId)}` : null
        },
        attachmentUrl: row.attachmentMediaId
            ? `/api/social/media/${encodeURIComponent(row.attachmentMediaId)}`
            : null,
        attachmentMimeType: row.attachmentMimeType || null,
        likesCount: row.likesCount || 0,
        commentsCount: row.commentsCount || 0,
        likedByMe: Boolean(row.likedByMe)
    };
}

function canAccessConversation(conversationId, userId) {
    return database.prepare(`
        SELECT c.* FROM conversations c
        WHERE c.id = ? AND (c.participant_a = ? OR c.participant_b = ?)
    `).get(conversationId, userId, userId);
}

function canAccessGroup(groupId, userId) {
    return Boolean(database.prepare(`
        SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?
    `).get(groupId, userId));
}

function canAccessMedia(media, viewerId) {
    if (media.purpose === "profile") return canViewProfile(media.resource_id, viewerId);
    if (media.purpose === "post") {
        return Boolean(accessiblePost(media.resource_id, viewerId) && database.prepare(`
            SELECT 1 FROM posts WHERE id = ? AND attachment_media_id = ? AND removed_at IS NULL
        `).get(media.resource_id, media.id));
    }
    if (media.purpose === "direct-message") {
        const conversation = canAccessConversation(media.resource_id, viewerId);
        return Boolean(conversation &&
            !isBlocked(conversation.participant_a, conversation.participant_b) &&
            database.prepare(`
                SELECT 1 FROM messages WHERE conversation_id = ? AND attachment_media_id = ?
                    AND deleted_at IS NULL
            `).get(media.resource_id, media.id));
    }
    if (media.purpose === "group-message") {
        return canAccessGroup(media.resource_id, viewerId) && Boolean(database.prepare(`
            SELECT 1 FROM group_messages WHERE group_id = ? AND attachment_media_id = ? AND removed_at IS NULL
        `).get(media.resource_id, media.id));
    }
    return false;
}

function deleteMediaRecord(mediaId) {
    if (!mediaId) return;
    const media = database.prepare("SELECT file_name FROM social_media WHERE id = ?").get(mediaId);
    if (media) fs.rmSync(path.join(socialUploads, media.file_name), { force: true });
    database.prepare("DELETE FROM social_media WHERE id = ?").run(mediaId);
}

function createSocialRoutes(app, options) {
    const sameOrigin = options.sameOrigin;
    const requireAdmin = options.requireAdmin;
    const write = [sameOrigin, requireUser];

    createMohammadAiRoutes(app, {
        sameOrigin,
        requireUser,
        requireAdmin,
        userActionLimit,
        storagePaths: options.storagePaths
    });

    app.get("/api/social/me", (request, response) => {
        const user = loadSessionUser(request);
        response.json({ user: user ? userSummary(user.id, user.id) : null });
    });

    app.post("/api/social/register", sameOrigin, async (request, response) => {
        socialSessionReady();
        const phoneNumber = normalizePhoneNumber(request.body?.phoneNumber);
        const fullName = boundedText(request.body?.fullName, 100, "Cikakken suna", true);
        const password = typeof request.body?.password === "string" ? request.body.password : "";
        const confirmPassword = typeof request.body?.confirmPassword === "string" ? request.body.confirmPassword : "";

        if (!validatePhoneNumber(phoneNumber)) {
            throw problem(400, "Lambar waya ba daidai ba. Yi amfani da lambar Najeriya, misali +2348012345678 ko 08012345678.");
        }
        if (password !== confirmPassword) {
            throw problem(400, "Kalmar sirri da tabbatarwa ba su dace ba.");
        }
        if (password.length < 6 || password.length > 256) {
            throw problem(400, "Kalmar sirri ta kasance tsakanin haruffa 12 zuwa 256.");
        }

        // Generate a username from phone number (last 9 digits) for backward compatibility
        const username = "user_" + phoneNumber.replace(/\D/g, "").slice(-9);

        const salt = crypto.randomBytes(16);
        const passwordHash = await new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, 64, (error, derivedKey) => {
                if (error) reject(error);
                else resolve(derivedKey);
            });
        });
        const userId = crypto.randomUUID();
        const timestamp = now();
        try {
            database.exec("BEGIN IMMEDIATE");
            database.prepare(`
                INSERT INTO users (id, username, phone_number, password_hash, password_salt, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(userId, username, phoneNumber, passwordHash.toString("hex"), salt.toString("hex"), timestamp, timestamp);
            database.prepare(`
                INSERT INTO profiles (user_id, full_name, updated_at) VALUES (?, ?, ?)
            `).run(userId, fullName, timestamp);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            if (String(error.message).includes("UNIQUE")) {
                if (String(error.message).includes("phone_number")) {
                    throw problem(409, "Wannan lambar waya an riga an É—auke shi.");
                }
                throw problem(409, "Wannan sunan mai amfani an riga an É—auke shi.");
            }
            throw error;
        }
        const user = database.prepare("SELECT * FROM users WHERE id = ?").get(userId);
        setUserCookie(response, user, request);
        response.status(201).json({ user: userSummary(userId, userId) });
    });

    app.post("/api/social/login", sameOrigin, async (request, response) => {
        socialSessionReady();
        const phoneNumber = normalizePhoneNumber(request.body?.phoneNumber);
        const password = typeof request.body?.password === "string" ? request.body.password : "";

        if (!validatePhoneNumber(phoneNumber)) {
            throw problem(400, "Lambar waya ba daidai ba. Shigar da lambar waya da ya dace.");
        }

        const user = database.prepare(`
            SELECT * FROM users WHERE phone_number = ? COLLATE NOCASE
        `).get(phoneNumber);

        // Fallback for existing users without phone_number - allow username login
        if (!user) {
            const username = boundedText(request.body?.phoneNumber, 30, "Sunan mai amfani", true);
            const fallbackUser = database.prepare(`
                SELECT * FROM users WHERE username = ? COLLATE NOCASE
            `).get(username);
            if (fallbackUser && !fallbackUser.is_suspended) {
                const hash = await new Promise((resolve, reject) => {
                    crypto.scrypt(password, Buffer.from(fallbackUser.password_salt, "hex"), 64, (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    });
                });
                const stored = Buffer.from(fallbackUser.password_hash, "hex");
                if (hash.length === stored.length && crypto.timingSafeEqual(hash, stored)) {
                    setUserCookie(response, fallbackUser, request);
                    return response.json({ user: userSummary(fallbackUser.id, fallbackUser.id) });
                }
            }
            throw problem(401, "Lambar waya ko kalmar sirri ba daidai ba ce.");
        }

        if (user.is_suspended) {
            throw problem(401, "Asusunka an dinga daga. Tuntube gudanarwa don taimako.");
        }

        const hash = await new Promise((resolve, reject) => {
            crypto.scrypt(password, Buffer.from(user.password_salt, "hex"), 64, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            });
        });
        const stored = Buffer.from(user.password_hash, "hex");
        if (hash.length !== stored.length || !crypto.timingSafeEqual(hash, stored)) {
            throw problem(401, "Lambar waya ko kalmar sirri ba daidai ba ce.");
        }
        setUserCookie(response, user, request);
        response.json({ user: userSummary(user.id, user.id) });
    });

    app.post("/api/social/logout", ...write, (request, response) => {
        clearUserCookie(response, request);
        response.json({ authenticated: false });
    });

    app.get("/api/social/users/search", requireUser, (request, response) => {
        const query = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 60) : "";
        const users = database.prepare(`
            SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id
            WHERE u.is_suspended = 0 AND u.id != ?
                AND (? = '' OR u.username LIKE ? OR p.full_name LIKE ?)
                AND NOT EXISTS (
                    SELECT 1 FROM blocks b WHERE
                        (b.blocker_id = ? AND b.blocked_id = u.id) OR
                        (b.blocker_id = u.id AND b.blocked_id = ?)
                )
            ORDER BY u.username LIMIT 30
        `).all(
            request.user.id, query, `%${query}%`, `%${query}%`,
            request.user.id, request.user.id
        ).map((row) => userSummary(row.id, request.user.id));
        response.json({ users });
    });

    app.get("/api/social/users/:username", requireUser, (request, response) => {
        const target = database.prepare(`
            SELECT u.id FROM users u WHERE u.username = ? COLLATE NOCASE AND u.is_suspended = 0
        `).get(request.params.username);
        if (!target || isBlocked(target.id, request.user.id)) {
            throw problem(404, "Ba a sami wannan mai amfani ba.");
        }
        const profile = userSummary(target.id, request.user.id);
        const allowed = canViewProfile(target.id, request.user.id);
        response.json({
            profile: {
                ...profile,
                bio: allowed ? profile.bio : "",
                photoUrl: allowed && profile.photoMediaId
                    ? `/api/social/media/${encodeURIComponent(profile.photoMediaId)}`
                    : null,
                pendingForMe: Boolean(database.prepare(`
                    SELECT 1 FROM follow_requests WHERE requester_id = ? AND target_id = ?
                `).get(target.id, request.user.id))
            }
        });
    });

    app.get("/api/social/users/:username/followers", requireUser, (request, response) => {
        const target = database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
            .get(request.params.username);
        if (!target || isBlocked(target.id, request.user.id)) throw problem(404, "Ba a sami wannan asusu ba.");
        if (!canViewProfile(target.id, request.user.id)) throw problem(403, "Wannan jerin na asusu mai zaman kansa ne.");
        const users = database.prepare(`
            SELECT follower_id AS id FROM follows WHERE following_id = ? ORDER BY created_at DESC LIMIT 100
        `).all(target.id).map((row) => userSummary(row.id, request.user.id));
        response.json({ users });
    });

    app.get("/api/social/users/:username/following", requireUser, (request, response) => {
        const target = database.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE")
            .get(request.params.username);
        if (!target || isBlocked(target.id, request.user.id)) throw problem(404, "Ba a sami wannan asusu ba.");
        if (!canViewProfile(target.id, request.user.id)) throw problem(403, "Wannan jerin na asusu mai zaman kansa ne.");
        const users = database.prepare(`
            SELECT following_id AS id FROM follows WHERE follower_id = ? ORDER BY created_at DESC LIMIT 100
        `).all(target.id).map((row) => userSummary(row.id, request.user.id));
        response.json({ users });
    });

    app.post("/api/social/users/:id/follow", ...write, userActionLimit(60), (request, response) => {
        const targetId = idFrom(request.params.id, "Asusun");
        if (targetId === request.user.id) throw problem(400, "Ba za ka iya bin asusunka ba.");
        if (isBlocked(targetId, request.user.id)) throw problem(404, "Ba a sami wannan asusu ba.");
        const target = database.prepare(`
            SELECT u.id, p.is_private FROM users u JOIN profiles p ON p.user_id = u.id
            WHERE u.id = ? AND u.is_suspended = 0
        `).get(targetId);
        if (!target) throw problem(404, "Ba a sami wannan asusu ba.");
        if (target.is_private) {
            const inserted = database.prepare(`
                INSERT OR IGNORE INTO follow_requests (requester_id, target_id, created_at) VALUES (?, ?, ?)
            `).run(request.user.id, targetId, now());
            if (inserted.changes) notify(targetId, request.user.id, "follow_request", request.user.id);
            response.status(202).json({ status: "requested" });
            return;
        }
        const inserted = database.prepare(`
            INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)
        `).run(request.user.id, targetId, now());
        if (inserted.changes) notify(targetId, request.user.id, "new_follower", request.user.id);
        database.prepare("DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?")
            .run(request.user.id, targetId);
        response.json({ status: "following" });
    });

    app.delete("/api/social/users/:id/follow", ...write, (request, response) => {
        const targetId = idFrom(request.params.id, "Asusun");
        database.prepare("DELETE FROM follows WHERE follower_id = ? AND following_id = ?")
            .run(request.user.id, targetId);
        database.prepare("DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?")
            .run(request.user.id, targetId);
        response.json({ status: "unfollowed" });
    });

    app.get("/api/social/follow-requests", requireUser, (request, response) => {
        const users = database.prepare(`
            SELECT requester_id AS id FROM follow_requests WHERE target_id = ?
            ORDER BY created_at DESC LIMIT 100
        `).all(request.user.id).map((row) => userSummary(row.id, request.user.id));
        response.json({ users });
    });

    app.post("/api/social/follow-requests/:id/:decision", ...write, (request, response) => {
        const requesterId = idFrom(request.params.id, "BuÆ™atar bin asusu");
        if (!["accept", "reject"].includes(request.params.decision)) {
            throw problem(404, "Ba a sami wannan mataki ba.");
        }
        const result = database.prepare(`
            DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?
        `).run(requesterId, request.user.id);
        if (!result.changes) throw problem(404, "Ba a sami buÆ™atar bin asusu ba.");
        if (request.params.decision === "accept") {
            database.prepare(`
                INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)
            `).run(requesterId, request.user.id, now());
            notify(requesterId, request.user.id, "follow_accepted", request.user.id);
        }
        response.json({ status: request.params.decision === "accept" ? "accepted" : "rejected" });
    });

    app.put("/api/social/profile", ...write, (request, response) => {
        const fullName = boundedText(request.body?.fullName, 100, "Cikakken suna", true);
        const bio = boundedText(request.body?.bio, 280, "Takaitaccen bayani");
        const isPrivate = request.body?.isPrivate === true;
        const messagePolicy = request.body?.messagePolicy;
        if (!["everyone", "following", "requests"].includes(messagePolicy)) {
            throw problem(400, "Tsarin karÉ“ar saÆ™onni bai inganta ba.");
        }
        database.prepare(`
            UPDATE profiles SET full_name = ?, bio = ?, is_private = ?,
                message_policy = ?, updated_at = ? WHERE user_id = ?
        `).run(fullName, bio, isPrivate ? 1 : 0, messagePolicy, now(), request.user.id);
        response.json({ profile: userSummary(request.user.id, request.user.id) });
    });

    app.post("/api/social/profile/photo", ...write, profileUpload.single("photo"), (request, response) => {
        if (!request.file) throw problem(400, "ZaÉ“i hoton profile.");
        const mediaId = saveMedia(request.file, request.user.id, "profile", request.user.id);
        database.prepare("UPDATE profiles SET photo_media_id = ?, updated_at = ? WHERE user_id = ?")
            .run(mediaId, now(), request.user.id);
        response.status(201).json({
            photoUrl: `/api/social/media/${encodeURIComponent(mediaId)}`,
            profile: userSummary(request.user.id, request.user.id)
        });
    });

    app.get("/api/social/favorites", requireUser, (request, response) => {
        const movies = database.prepare(`
            SELECT m.id, m.title, m.original_title AS originalTitle, m.hausa_title AS hausaTitle,
                m.studio, m.year, m.poster_path AS posterUrl, f.created_at AS createdAt
            FROM favorites f JOIN movies m ON m.id = f.movie_id
            WHERE f.user_id = ? AND m.permission_confirmed = 1 ORDER BY f.created_at DESC
        `).all(request.user.id);
        response.json({ movies: movies.map((movie) => ({
            ...movie,
            posterUrl: moviePosterUrl(movie.id, movie.posterUrl || null)
        })) });
    });

    app.post("/api/social/favorites/:movieId", ...write, (request, response) => {
        const movie = validateMovie(request.params.movieId);
        if (!movie) throw problem(404, "Ba a sami fim É—in ba.");
        database.prepare(`
            INSERT OR IGNORE INTO favorites (user_id, movie_id, created_at) VALUES (?, ?, ?)
        `).run(request.user.id, movie.id, now());
        response.status(201).json({ favorite: true });
    });

    app.delete("/api/social/favorites/:movieId", ...write, (request, response) => {
        database.prepare("DELETE FROM favorites WHERE user_id = ? AND movie_id = ?")
            .run(request.user.id, request.params.movieId);
        response.json({ favorite: false });
    });

    app.get("/api/social/studios", requireUser, (request, response) => {
        const studios = database.prepare(`
            SELECT s.id, s.name, s.permission_status AS permissionStatus,
                EXISTS(SELECT 1 FROM user_studio_follows f
                    WHERE f.studio_id = s.id AND f.user_id = ?) AS isFollowing,
                (SELECT COUNT(*) FROM user_studio_follows f WHERE f.studio_id = s.id) AS followersCount
            FROM studios s ORDER BY s.name
        `).all(request.user.id);
        response.json({ studios });
    });

    app.post("/api/social/studios/:id/follow", ...write, (request, response) => {
        const studioId = idFrom(request.params.id, "Studio");
        const exists = database.prepare("SELECT id FROM studios WHERE id = ?").get(studioId);
        if (!exists) throw problem(404, "Ba a sami wannan studio ba.");
        database.prepare(`
            INSERT OR IGNORE INTO user_studio_follows (user_id, studio_id, created_at) VALUES (?, ?, ?)
        `).run(request.user.id, studioId, now());
        response.json({ following: true });
    });

    app.delete("/api/social/studios/:id/follow", ...write, (request, response) => {
        database.prepare("DELETE FROM user_studio_follows WHERE user_id = ? AND studio_id = ?")
            .run(request.user.id, request.params.id);
        response.json({ following: false });
    });

    app.get("/api/social/feed", requireUser, (request, response) => {
        const scope = request.query.scope === "following" ? "following"
            : request.query.scope === "popular" ? "popular" : "discover";
        const limit = Math.min(50, Math.max(1, Number.parseInt(request.query.limit, 10) || 20));
        const offset = Math.max(0, Number.parseInt(request.query.offset, 10) || 0);
        const access = `p.removed_at IS NULL AND (
            p.author_id = ? OR pr.is_private = 0 OR EXISTS (
                SELECT 1 FROM follows vf WHERE vf.follower_id = ? AND vf.following_id = p.author_id
            )
        )`;
        const relation = scope === "following"
            ? `AND (p.author_id = ? OR EXISTS (
                SELECT 1 FROM follows ff WHERE ff.follower_id = ? AND ff.following_id = p.author_id
            ))`
            : "";
        const order = scope === "popular"
            ? `(SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) * 2 +
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.removed_at IS NULL) DESC, p.created_at DESC`
            : "p.created_at DESC";
        const rows = database.prepare(`
            SELECT p.id, p.author_id AS authorId, p.content, p.post_type AS postType,
                p.movie_id AS movieId, p.rating, p.authorized_link AS authorizedLink,
                p.shared_post_id AS sharedPostId, p.attachment_media_id AS attachmentMediaId,
                p.created_at AS createdAt, u.username, pr.full_name AS fullName,
                pr.photo_media_id AS photoMediaId, sm.mime_type AS attachmentMimeType, m.title AS movieTitle,
                m.poster_path AS posterUrl,
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS likesCount,
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.removed_at IS NULL) AS commentsCount,
                EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id = p.id AND pl.user_id = ?) AS likedByMe
            FROM posts p JOIN users u ON u.id = p.author_id
            JOIN profiles pr ON pr.user_id = p.author_id
            LEFT JOIN social_media sm ON sm.id = p.attachment_media_id
            LEFT JOIN movies m ON m.id = p.movie_id AND m.permission_confirmed = 1
            WHERE ${access} AND NOT EXISTS (
                SELECT 1 FROM blocks b WHERE
                    (b.blocker_id = p.author_id AND b.blocked_id = ?) OR
                    (b.blocker_id = ? AND b.blocked_id = p.author_id)
            ) ${relation}
            ORDER BY ${order} LIMIT ? OFFSET ?
        `).all(...(scope === "following"
            ? [request.user.id, request.user.id, request.user.id, request.user.id,
                request.user.id, request.user.id, request.user.id, limit, offset]
            : [request.user.id, request.user.id, request.user.id, request.user.id, request.user.id, limit, offset]));
        response.json({ posts: rows.map((row) => postSummary(row, request.user.id)), scope });
    });

    app.post("/api/social/posts", ...write, userActionLimit(12), socialUpload.single("attachment"), (request, response) => {
        const content = boundedText(request.body?.content, 2000, "Rubutun post");
        const movie = validateMovie(request.body?.movieId || null);
        const authorizedLink = validateAuthorizedLink(request.body?.authorizedLink || null);
        if (!content && !movie && !authorizedLink && !request.file) {
            removeFile(request.file);
            throw problem(400, "Æ˜ara rubutu, fim, hanyar da aka amince da ita, ko hoto.");
        }
        const postId = crypto.randomUUID();
        const mediaId = saveMedia(request.file, request.user.id, "post", postId);
        const timestamp = now();
        database.prepare(`
            INSERT INTO posts (
                id, author_id, content, post_type, movie_id, authorized_link,
                attachment_media_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            postId, request.user.id, content, movie ? "share" : "text",
            movie?.id || null, authorizedLink, mediaId, timestamp
        );
        response.status(201).json({ post: { id: postId, content, movieId: movie?.id || null } });
    });

    app.post("/api/social/posts/:id/share", ...write, userActionLimit(20), (request, response) => {
        const original = accessiblePost(idFrom(request.params.id, "Post"), request.user.id);
        if (!original) throw problem(404, "Ba a sami post É—in ba.");
        const content = boundedText(request.body?.content, 1000, "Rubutun rabawa");
        const postId = crypto.randomUUID();
        database.prepare(`
            INSERT INTO posts (id, author_id, content, post_type, shared_post_id, created_at)
            VALUES (?, ?, ?, 'share', ?, ?)
        `).run(postId, request.user.id, content, original.id, now());
        response.status(201).json({ postId });
    });

    app.post("/api/social/posts/:id/like", ...write, (request, response) => {
        const post = accessiblePost(idFrom(request.params.id, "Post"), request.user.id);
        if (!post) throw problem(404, "Ba a sami post É—in ba.");
        const existing = database.prepare("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?")
            .get(post.id, request.user.id);
        if (existing) {
            database.prepare("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?")
                .run(post.id, request.user.id);
            response.json({ liked: false });
            return;
        }
        database.prepare("INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)")
            .run(post.id, request.user.id, now());
        notify(post.authorId, request.user.id, "post_like", post.id);
        response.json({ liked: true });
    });

    app.get("/api/social/posts/:id/comments", requireUser, (request, response) => {
        const post = accessiblePost(idFrom(request.params.id, "Post"), request.user.id);
        if (!post) throw problem(404, "Ba a sami post É—in ba.");
        const comments = database.prepare(`
            SELECT c.id, c.post_id AS postId, c.parent_id AS parentId,
                c.content, c.created_at AS createdAt, u.id AS userId,
                u.username, p.full_name AS fullName, p.photo_media_id AS photoMediaId
            FROM comments c JOIN users u ON u.id = c.author_id
            JOIN profiles p ON p.user_id = u.id
            WHERE c.post_id = ? AND c.removed_at IS NULL
            ORDER BY c.created_at LIMIT 200
        `).all(post.id).map((comment) => ({
            ...comment,
            photoUrl: comment.photoMediaId
                ? `/api/social/media/${encodeURIComponent(comment.photoMediaId)}`
                : null
        }));
        response.json({ comments });
    });

    app.post("/api/social/posts/:id/comments", ...write, userActionLimit(40), (request, response) => {
        const post = accessiblePost(idFrom(request.params.id, "Post"), request.user.id);
        if (!post) throw problem(404, "Ba a sami post É—in ba.");
        const content = boundedText(request.body?.content, 1000, "Sharhi", true);
        const parentId = request.body?.parentId ? idFrom(request.body.parentId, "Amsar sharhi") : null;
        let parent = null;
        if (parentId) {
            parent = database.prepare(`
                SELECT id, author_id AS authorId FROM comments
                WHERE id = ? AND post_id = ? AND removed_at IS NULL
            `).get(parentId, post.id);
            if (!parent) throw problem(404, "Ba a sami sharhin da za a amsa ba.");
        }
        const commentId = crypto.randomUUID();
        database.prepare(`
            INSERT INTO comments (id, post_id, author_id, parent_id, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(commentId, post.id, request.user.id, parentId, content, now());
        notify(parent ? parent.authorId : post.authorId, request.user.id,
            parent ? "comment_reply" : "post_comment", commentId, { postId: post.id });
        response.status(201).json({ commentId });
    });

    app.post("/api/social/movies/:movieId/reviews", ...write, userActionLimit(10), (request, response) => {
        const movie = validateMovie(request.params.movieId);
        if (!movie) throw problem(404, "Ba a sami fim É—in ba.");
        const rating = Number(request.body?.rating);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            throw problem(400, "Æ˜imar fim ta kasance daga tauraro 1 zuwa 5.");
        }
        const body = boundedText(request.body?.body, 2000, "Sharhin fim");
        const timestamp = now();
        const existing = database.prepare(`
            SELECT id, post_id AS postId FROM reviews WHERE user_id = ? AND movie_id = ?
        `).get(request.user.id, movie.id);
        if (existing) {
            database.exec("BEGIN IMMEDIATE");
            try {
                database.prepare(`
                    UPDATE reviews SET rating = ?, body = ?, updated_at = ? WHERE id = ?
                `).run(rating, body, timestamp, existing.id);
                database.prepare(`
                    UPDATE posts SET content = ?, rating = ?, created_at = ? WHERE id = ?
                `).run(body, rating, timestamp, existing.postId);
                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");
                throw error;
            }
            response.json({ reviewId: existing.id, updated: true });
            return;
        }
        const reviewId = crypto.randomUUID();
        const postId = crypto.randomUUID();
        database.exec("BEGIN IMMEDIATE");
        try {
            database.prepare(`
                INSERT INTO posts (id, author_id, content, post_type, movie_id, rating, created_at)
                VALUES (?, ?, ?, 'review', ?, ?, ?)
            `).run(postId, request.user.id, body, movie.id, rating, timestamp);
            database.prepare(`
                INSERT INTO reviews (id, user_id, movie_id, post_id, rating, body, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(reviewId, request.user.id, movie.id, postId, rating, body, timestamp);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        response.status(201).json({ reviewId, postId, updated: false });
    });

    app.get("/api/social/notifications", requireUser, (request, response) => {
        const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit, 10) || 50));
        const notifications = database.prepare(`
            SELECT n.id, n.type, n.entity_id AS entityId, n.payload_json AS payloadJson,
                n.created_at AS createdAt, n.read_at AS readAt, u.username AS actorUsername,
                p.full_name AS actorFullName
            FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
            LEFT JOIN profiles p ON p.user_id = u.id
            WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT ?
        `).all(request.user.id, limit).map((item) => ({
            ...item,
            payload: JSON.parse(item.payloadJson)
        }));
        const unreadCount = database.prepare(`
            SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND read_at IS NULL
        `).get(request.user.id).count;
        response.json({ notifications, unreadCount });
    });

    app.post("/api/social/notifications/read", ...write, (request, response) => {
        database.prepare(`
            UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL
        `).run(now(), request.user.id);
        response.json({ read: true });
    });

    app.get("/api/social/blocks", requireUser, (request, response) => {
        const users = database.prepare(`
            SELECT blocked_id AS id FROM blocks WHERE blocker_id = ? ORDER BY created_at DESC
        `).all(request.user.id).map((row) => userSummary(row.id, request.user.id));
        response.json({ users });
    });

    app.post("/api/social/blocks/:id", ...write, (request, response) => {
        const blockedId = idFrom(request.params.id, "Asusun");
        if (blockedId === request.user.id ||
            !database.prepare("SELECT id FROM users WHERE id = ?").get(blockedId)) {
            throw problem(400, "Ba za a iya toshe wannan asusu ba.");
        }
        database.prepare(`
            INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
        `).run(request.user.id, blockedId, now());
        database.prepare(`
            DELETE FROM follows WHERE (follower_id = ? AND following_id = ?)
                OR (follower_id = ? AND following_id = ?)
        `).run(request.user.id, blockedId, blockedId, request.user.id);
        database.prepare(`
            DELETE FROM follow_requests WHERE (requester_id = ? AND target_id = ?)
                OR (requester_id = ? AND target_id = ?)
        `).run(request.user.id, blockedId, blockedId, request.user.id);
        response.json({ blocked: true });
    });

    app.delete("/api/social/blocks/:id", ...write, (request, response) => {
        database.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
            .run(request.user.id, request.params.id);
        response.json({ blocked: false });
    });

    app.post("/api/social/reports", ...write, userActionLimit(8), (request, response) => {
        const type = request.body?.targetType;
        const targetId = idFrom(request.body?.targetId, "Abin da aka kai rahoto");
        const reason = boundedText(request.body?.reason, 100, "Dalilin rahoto", true);
        const details = boundedText(request.body?.details, 1000, "Æ˜arin bayani");
        if (!["user", "post", "comment", "message", "group"].includes(type)) {
            throw problem(400, "Nau'in rahoto bai inganta ba.");
        }
        const tableByType = {
            user: "users",
            post: "posts",
            comment: "comments",
            message: "messages",
            group: "groups"
        };
        const target = database.prepare(`SELECT id FROM ${tableByType[type]} WHERE id = ?`).get(targetId);
        if (!target || (type === "user" && targetId === request.user.id)) {
            throw problem(404, "Ba a sami abin da aka kai rahoto ba.");
        }
        if (type === "post" && !accessiblePost(targetId, request.user.id)) {
            throw problem(404, "Ba a sami abin da aka kai rahoto ba.");
        }
        if (type === "comment") {
            const comment = database.prepare("SELECT post_id AS postId FROM comments WHERE id = ?").get(targetId);
            if (!comment || !accessiblePost(comment.postId, request.user.id)) {
                throw problem(404, "Ba a sami abin da aka kai rahoto ba.");
            }
        }
        if (type === "message") {
            const message = database.prepare(`
                SELECT c.participant_a AS participantA, c.participant_b AS participantB
                FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?
            `).get(targetId);
            if (!message || ![message.participantA, message.participantB].includes(request.user.id) ||
                isBlocked(message.participantA, message.participantB)) {
                throw problem(404, "Ba a sami abin da aka kai rahoto ba.");
            }
        }
        if (type === "group" && !canAccessGroup(targetId, request.user.id)) {
            throw problem(404, "Ba a sami abin da aka kai rahoto ba.");
        }
        const duplicate = database.prepare(`
            SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'
        `).get(request.user.id, type, targetId);
        if (duplicate) throw problem(409, "Ka riga ka kai rahoton wannan abu.");
        const reportId = crypto.randomUUID();
        database.prepare(`
            INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(reportId, request.user.id, type, targetId, reason, details, now());
        response.status(201).json({ reportId, status: "open" });
    });

    app.post("/api/social/conversations/:userId", ...write, (request, response) => {
        const peerId = idFrom(request.params.userId, "Mai karÉ“ar saÆ™o");
        if (peerId === request.user.id || isBlocked(request.user.id, peerId)) {
            throw problem(404, "Ba a sami wannan mai amfani ba.");
        }
        const peer = database.prepare(`
            SELECT u.id, p.message_policy AS messagePolicy FROM users u
            JOIN profiles p ON p.user_id = u.id
            WHERE u.id = ? AND u.is_suspended = 0
        `).get(peerId);
        if (!peer) throw problem(404, "Ba a sami wannan mai amfani ba.");
        const follows = Boolean(database.prepare(`
            SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?
        `).get(request.user.id, peerId));
        if (peer.messagePolicy === "following" && !follows) {
            throw problem(403, "Wannan mai amfani yana karÉ“ar saÆ™onni daga mutanen da yake bi kawai.");
        }
        const [participantA, participantB] = [request.user.id, peerId].sort();
        const existing = database.prepare(`
            SELECT id FROM conversations WHERE participant_a = ? AND participant_b = ?
        `).get(participantA, participantB);
        if (existing) {
            response.json({ conversationId: existing.id });
            return;
        }
        const id = crypto.randomUUID();
        const isRequest = peer.messagePolicy === "requests" && !follows;
        database.prepare(`
            INSERT INTO conversations (
                id, participant_a, participant_b, request_status, request_target_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, participantA, participantB, isRequest ? "pending" : "accepted",
            isRequest ? peerId : null, now(), now()
        );
        response.status(201).json({ conversationId: id, requestPending: isRequest });
    });

    app.get("/api/social/conversations", requireUser, (request, response) => {
        database.prepare(`
            UPDATE messages SET delivered_at = COALESCE(delivered_at, ?)
            WHERE sender_id != ? AND conversation_id IN (
                SELECT id FROM conversations WHERE participant_a = ? OR participant_b = ?
            ) AND deleted_at IS NULL
        `).run(now(), request.user.id, request.user.id, request.user.id);
        const rows = database.prepare(`
            SELECT c.id AS conversationId, c.request_status AS requestStatus,
                c.request_target_id AS requestTargetId,
                CASE WHEN c.participant_a = ? THEN c.participant_b ELSE c.participant_a END AS peerId,
                (SELECT content FROM messages m WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS lastMessage,
                (SELECT created_at FROM messages m WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC LIMIT 1) AS lastMessageAt
            FROM conversations c
            WHERE (c.participant_a = ? OR c.participant_b = ?)
                AND c.request_status != 'declined'
                AND NOT EXISTS (SELECT 1 FROM blocks b WHERE
                    (b.blocker_id = c.participant_a AND b.blocked_id = c.participant_b) OR
                    (b.blocker_id = c.participant_b AND b.blocked_id = c.participant_a))
            ORDER BY COALESCE(lastMessageAt, c.updated_at) DESC
        `).all(request.user.id, request.user.id, request.user.id);
        response.json({
            conversations: rows.map((row) => ({
                ...row,
                peer: userSummary(row.peerId, request.user.id)
            }))
        });
    });

    app.post("/api/social/conversations/:id/accept", ...write, (request, response) => {
        const conversation = canAccessConversation(idFrom(request.params.id, "Tattaunawa"), request.user.id);
        if (!conversation || conversation.request_status !== "pending" ||
            conversation.request_target_id !== request.user.id) {
            throw problem(404, "Ba a sami buÆ™atar saÆ™o ba.");
        }
        database.prepare(`
            UPDATE conversations SET request_status = 'accepted', request_target_id = NULL, updated_at = ?
            WHERE id = ?
        `).run(now(), conversation.id);
        response.json({ status: "accepted" });
    });

    app.post("/api/social/conversations/:id/reject", ...write, (request, response) => {
        const conversation = canAccessConversation(idFrom(request.params.id, "Tattaunawa"), request.user.id);
        if (!conversation || conversation.request_status !== "pending" ||
            conversation.request_target_id !== request.user.id) {
            throw problem(404, "Ba a sami buÆ™atar saÆ™o ba.");
        }
        database.prepare("UPDATE conversations SET request_status = 'declined', updated_at = ? WHERE id = ?")
            .run(now(), conversation.id);
        response.json({ status: "declined" });
    });

    app.get("/api/social/conversations/:id/messages", requireUser, (request, response) => {
        const conversation = canAccessConversation(idFrom(request.params.id, "Tattaunawa"), request.user.id);
        if (!conversation) throw problem(404, "Ba a sami tattaunawar ba.");
        const peerId = conversation.participant_a === request.user.id
            ? conversation.participant_b : conversation.participant_a;
        if (isBlocked(request.user.id, peerId) || conversation.request_status === "declined") {
            throw problem(403, "Ba za a iya buÉ—e wannan tattaunawar ba.");
        }
        database.prepare(`
            UPDATE messages SET delivered_at = COALESCE(delivered_at, ?), read_at = COALESCE(read_at, ?)
            WHERE conversation_id = ? AND sender_id != ? AND deleted_at IS NULL
        `).run(now(), now(), conversation.id, request.user.id);
        const messages = database.prepare(`
            SELECT m.id, m.sender_id AS senderId, m.content, m.movie_id AS movieId,
                m.authorized_link AS authorizedLink, m.attachment_media_id AS attachmentMediaId,
                m.reply_to_id AS replyToId, m.delivered_at AS deliveredAt,
                m.read_at AS readAt, m.deleted_at AS deletedAt, m.created_at AS createdAt,
                m2.content AS replyContent, m2.sender_id AS replySenderId,
                media.mime_type AS attachmentMimeType,
                movie.title AS movieTitle, movie.poster_path AS posterUrl
            FROM messages m LEFT JOIN messages m2 ON m2.id = m.reply_to_id
            LEFT JOIN social_media media ON media.id = m.attachment_media_id
            LEFT JOIN movies movie ON movie.id = m.movie_id AND movie.permission_confirmed = 1
            WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 100
        `).all(conversation.id).reverse().map((message) => ({
            ...message,
            posterUrl: moviePosterUrl(message.movieId, message.posterUrl || null),
            reactions: database.prepare(`
                SELECT reaction, COUNT(*) AS count,
                    MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reactedByMe
                FROM message_reactions WHERE message_id = ? GROUP BY reaction
            `).all(request.user.id, message.id),
            attachmentUrl: message.attachmentMediaId
                ? `/api/social/media/${encodeURIComponent(message.attachmentMediaId)}`
                : null,
            attachmentMimeType: message.attachmentMimeType || null
        }));
        response.json({
            messages,
            requestStatus: conversation.request_status,
            requestTargetId: conversation.request_target_id,
            peerId
        });
    });

    app.post("/api/social/conversations/:id/messages", ...write, userActionLimit(60),
        socialUpload.single("attachment"), (request, response) => {
            const conversation = canAccessConversation(idFrom(request.params.id, "Tattaunawa"), request.user.id);
            if (!conversation) {
                removeFile(request.file);
                throw problem(404, "Ba a sami tattaunawar ba.");
            }
            const peerId = conversation.participant_a === request.user.id
                ? conversation.participant_b : conversation.participant_a;
            if (isBlocked(request.user.id, peerId)) {
                removeFile(request.file);
                throw problem(403, "Ba za a iya aika saÆ™o ga wannan mai amfani ba.");
            }
            if (conversation.request_status === "declined" ||
                (conversation.request_status === "pending" &&
                    (conversation.request_target_id === request.user.id ||
                        database.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?")
                            .get(conversation.id).count > 0))) {
                removeFile(request.file);
                throw problem(403, "Dole ne a amince da buÆ™atar saÆ™o kafin a ci gaba.");
            }
            const content = boundedText(request.body?.content, 3000, "SaÆ™o");
            const movie = validateMovie(request.body?.movieId || null);
            const authorizedLink = validateAuthorizedLink(request.body?.authorizedLink || null);
            if (!content && !movie && !authorizedLink && !request.file) {
                removeFile(request.file);
                throw problem(400, "SaÆ™o ba zai zama babu komai ba.");
            }
            const replyToId = request.body?.replyToId ? idFrom(request.body.replyToId, "SaÆ™on amsa") : null;
            if (replyToId && !database.prepare(`
                SELECT id FROM messages WHERE id = ? AND conversation_id = ?
            `).get(replyToId, conversation.id)) {
                removeFile(request.file);
                throw problem(400, "SaÆ™on da za a amsa ba ya cikin wannan tattaunawa.");
            }
            const mediaId = saveMedia(request.file, request.user.id, "direct-message", conversation.id);
            const messageId = crypto.randomUUID();
            const timestamp = now();
            database.prepare(`
                INSERT INTO messages (
                    id, conversation_id, sender_id, content, movie_id, authorized_link,
                    attachment_media_id, reply_to_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                messageId, conversation.id, request.user.id, content,
                movie?.id || null, authorizedLink, mediaId, replyToId, timestamp
            );
            database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
                .run(timestamp, conversation.id);
            if (conversation.request_status === "pending") {
                notify(peerId, request.user.id, "private_message_request", conversation.id);
            } else {
                notify(peerId, request.user.id, "private_message", conversation.id);
            }
            response.status(201).json({ messageId, status: "sent" });
        });

    app.post("/api/social/messages/:id/reactions", ...write, (request, response) => {
        const messageId = idFrom(request.params.id, "SaÆ™o");
        const reaction = boundedText(request.body?.reaction, 16, "Alamar martani", true);
        const message = database.prepare(`
            SELECT m.id, c.participant_a AS participantA, c.participant_b AS participantB
            FROM messages m JOIN conversations c ON c.id = m.conversation_id
            WHERE m.id = ? AND m.deleted_at IS NULL
        `).get(messageId);
        if (!message || ![message.participantA, message.participantB].includes(request.user.id) ||
            isBlocked(message.participantA, message.participantB)) {
            throw problem(404, "Ba a sami saÆ™on ba.");
        }
        if (!reactions.has(reaction)) throw problem(400, "Ba a amince da wannan martani ba.");
        const existing = database.prepare(`
            SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?
        `).get(messageId, request.user.id, reaction);
        if (existing) {
            database.prepare(`
                DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?
            `).run(messageId, request.user.id, reaction);
        } else {
            database.prepare(`
                INSERT INTO message_reactions (message_id, user_id, reaction, created_at)
                VALUES (?, ?, ?, ?)
            `).run(messageId, request.user.id, reaction, now());
        }
        response.json({ reacted: !existing });
    });

    app.delete("/api/social/messages/:id", ...write, (request, response) => {
        const message = database.prepare(`
            SELECT id, sender_id AS senderId, attachment_media_id AS attachmentMediaId
            FROM messages WHERE id = ?
        `).get(request.params.id);
        if (!message || message.senderId !== request.user.id) throw problem(404, "Ba a sami saÆ™onka ba.");
        database.prepare(`
            UPDATE messages SET content = '', movie_id = NULL, authorized_link = NULL,
                attachment_media_id = NULL, deleted_at = ?, read_at = NULL WHERE id = ?
        `).run(now(), message.id);
        if (message.attachmentMediaId) {
            const media = database.prepare("SELECT file_name FROM social_media WHERE id = ?")
                .get(message.attachmentMediaId);
            if (media) fs.rmSync(path.join(socialUploads, media.file_name), { force: true });
            database.prepare("DELETE FROM social_media WHERE id = ?").run(message.attachmentMediaId);
        }
        response.json({ deleted: true });
    });

    app.get("/api/social/groups", requireUser, (request, response) => {
        const groups = database.prepare(`
            SELECT g.id, g.name, g.description, g.owner_id AS ownerId, g.created_at AS createdAt,
                (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS membersCount,
                EXISTS(SELECT 1 FROM group_members gm
                    WHERE gm.group_id = g.id AND gm.user_id = ?) AS isMember
            FROM groups g ORDER BY membersCount DESC, g.created_at DESC LIMIT 100
        `).all(request.user.id);
        response.json({ groups });
    });

    app.post("/api/social/groups", ...write, userActionLimit(5), (request, response) => {
        if (!request.user.can_create_groups) throw problem(403, "Ba a ba ka izinin Æ™irÆ™irar Æ™ungiya ba.");
        const name = boundedText(request.body?.name, 80, "Sunan Æ™ungiya", true);
        const description = boundedText(request.body?.description, 500, "Bayanin Æ™ungiya");
        const groupId = crypto.randomUUID();
        const timestamp = now();
        database.exec("BEGIN IMMEDIATE");
        try {
            database.prepare(`
                INSERT INTO groups (id, owner_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)
            `).run(groupId, request.user.id, name, description, timestamp);
            database.prepare(`
                INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)
            `).run(groupId, request.user.id, timestamp);
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
        response.status(201).json({ groupId });
    });

    app.post("/api/social/groups/:id/join", ...write, (request, response) => {
        const groupId = idFrom(request.params.id, "Æ˜ungiya");
        if (!database.prepare("SELECT id FROM groups WHERE id = ?").get(groupId)) {
            throw problem(404, "Ba a sami Æ™ungiyar ba.");
        }
        database.prepare(`
            INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at)
            VALUES (?, ?, 'member', ?)
        `).run(groupId, request.user.id, now());
        response.json({ joined: true });
    });

    app.delete("/api/social/groups/:id/join", ...write, (request, response) => {
        const membership = database.prepare(`
            SELECT role FROM group_members WHERE group_id = ? AND user_id = ?
        `).get(request.params.id, request.user.id);
        if (membership?.role === "owner") throw problem(409, "Mai Æ™ungiya ba zai iya fita ba tare da canja mallaka ba.");
        database.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?")
            .run(request.params.id, request.user.id);
        response.json({ joined: false });
    });

    app.get("/api/social/groups/:id/messages", requireUser, (request, response) => {
        const groupId = idFrom(request.params.id, "Æ˜ungiya");
        if (!canAccessGroup(groupId, request.user.id)) throw problem(403, "Sai ka shiga Æ™ungiyar kafin ka karanta saÆ™onni.");
        database.prepare(`
            UPDATE notifications SET read_at = COALESCE(read_at, ?)
            WHERE user_id = ? AND type = 'group_message' AND entity_id = ?
        `).run(now(), request.user.id, groupId);
        const messages = database.prepare(`
            SELECT gm.id, gm.sender_id AS senderId, u.username, p.full_name AS fullName,
                gm.content, gm.movie_id AS movieId, gm.authorized_link AS authorizedLink,
                gm.attachment_media_id AS attachmentMediaId, gm.reply_to_id AS replyToId,
                gm.created_at AS createdAt, reply.content AS replyContent,
                media.mime_type AS attachmentMimeType,
                movie.title AS movieTitle, movie.poster_path AS posterUrl
            FROM group_messages gm JOIN users u ON u.id = gm.sender_id
            JOIN profiles p ON p.user_id = gm.sender_id
            LEFT JOIN group_messages reply ON reply.id = gm.reply_to_id
            LEFT JOIN social_media media ON media.id = gm.attachment_media_id
            LEFT JOIN movies movie ON movie.id = gm.movie_id AND movie.permission_confirmed = 1
            WHERE gm.group_id = ? AND gm.removed_at IS NULL
            ORDER BY gm.created_at DESC LIMIT 100
        `).all(groupId).reverse().map((message) => ({
            ...message,
            posterUrl: moviePosterUrl(message.movieId, message.posterUrl || null),
            attachmentUrl: message.attachmentMediaId
                ? `/api/social/media/${encodeURIComponent(message.attachmentMediaId)}`
                : null,
            attachmentMimeType: message.attachmentMimeType || null,
            reactions: database.prepare(`
                SELECT reaction, COUNT(*) AS count,
                    MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS reactedByMe
                FROM group_message_reactions WHERE message_id = ? GROUP BY reaction
            `).all(request.user.id, message.id)
        }));
        response.json({ messages });
    });

    app.post("/api/social/groups/:id/messages", ...write, userActionLimit(60),
        socialUpload.single("attachment"), (request, response) => {
            const groupId = idFrom(request.params.id, "Æ˜ungiya");
            if (!canAccessGroup(groupId, request.user.id)) {
                removeFile(request.file);
                throw problem(403, "Sai ka shiga Æ™ungiyar kafin ka aika saÆ™o.");
            }
            const content = boundedText(request.body?.content, 3000, "SaÆ™on Æ™ungiya");
            const movie = validateMovie(request.body?.movieId || null);
            const authorizedLink = validateAuthorizedLink(request.body?.authorizedLink || null);
            if (!content && !movie && !authorizedLink && !request.file) {
                removeFile(request.file);
                throw problem(400, "SaÆ™on Æ™ungiya ba zai zama babu komai ba.");
            }
            const replyToId = request.body?.replyToId ? idFrom(request.body.replyToId, "SaÆ™on amsa") : null;
            if (replyToId && !database.prepare(`
                SELECT id FROM group_messages WHERE id = ? AND group_id = ? AND removed_at IS NULL
            `).get(replyToId, groupId)) {
                removeFile(request.file);
                throw problem(400, "SaÆ™on da za a amsa ba ya cikin Æ™ungiyar.");
            }
            const mediaId = saveMedia(request.file, request.user.id, "group-message", groupId);
            const messageId = crypto.randomUUID();
            const timestamp = now();
            database.prepare(`
                INSERT INTO group_messages (
                    id, group_id, sender_id, content, movie_id, authorized_link,
                    attachment_media_id, reply_to_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                messageId, groupId, request.user.id, content,
                movie?.id || null, authorizedLink, mediaId, replyToId, timestamp
            );
            database.prepare(`
                UPDATE notifications SET read_at = COALESCE(read_at, ?)
                WHERE user_id = ? AND type = 'group_message' AND entity_id = ?
            `).run(timestamp, request.user.id, groupId);
            const members = database.prepare(`
                SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?
            `).all(groupId, request.user.id);
            for (const member of members) notify(member.user_id, request.user.id, "group_message", groupId);
            response.status(201).json({ messageId });
        });

    app.post("/api/social/group-messages/:id/reactions", ...write, (request, response) => {
        const messageId = idFrom(request.params.id, "SaÆ™on Æ™ungiya");
        const reaction = boundedText(request.body?.reaction, 16, "Alamar martani", true);
        const message = database.prepare(`
            SELECT id, group_id AS groupId FROM group_messages
            WHERE id = ? AND removed_at IS NULL
        `).get(messageId);
        if (!message || !canAccessGroup(message.groupId, request.user.id)) {
            throw problem(404, "Ba a sami saÆ™on Æ™ungiya ba.");
        }
        if (!reactions.has(reaction)) throw problem(400, "Ba a amince da wannan martani ba.");
        const existing = database.prepare(`
            SELECT 1 FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?
        `).get(messageId, request.user.id, reaction);
        if (existing) {
            database.prepare(`
                DELETE FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND reaction = ?
            `).run(messageId, request.user.id, reaction);
        } else {
            database.prepare(`
                INSERT INTO group_message_reactions (message_id, user_id, reaction, created_at)
                VALUES (?, ?, ?, ?)
            `).run(messageId, request.user.id, reaction, now());
        }
        response.json({ reacted: !existing });
    });

    app.get("/api/social/media/:id", requireUser, (request, response) => {
        const media = database.prepare("SELECT * FROM social_media WHERE id = ?").get(request.params.id);
        if (!media || !canAccessMedia(media, request.user.id)) throw problem(404, "Ba a sami fayil É—in ba.");
        const filePath = path.join(socialUploads, media.file_name);
        if (!fs.existsSync(filePath)) throw problem(404, "Fayil É—in ba ya nan a server.");
        response.setHeader("Content-Type", media.mime_type);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Disposition",
            media.mime_type.startsWith("image/") || media.mime_type.startsWith("audio/")
                ? "inline" : "attachment");
        response.sendFile(filePath);
    });

    app.get("/api/admin/social/reports", requireAdmin, (request, response) => {
        const reports = database.prepare(`
            SELECT r.id, r.reporter_id AS reporterId, reporter.username AS reporterUsername,
                r.target_type AS targetType, r.target_id AS targetId, r.reason, r.details,
                r.status, r.created_at AS createdAt, target_user.username AS targetUsername
            FROM reports r JOIN users reporter ON reporter.id = r.reporter_id
            LEFT JOIN users target_user ON r.target_type = 'user' AND target_user.id = r.target_id
            WHERE r.status = 'open' ORDER BY r.created_at LIMIT 200
        `).all();
        response.json({ reports });
    });

    app.patch("/api/admin/social/reports/:id", sameOrigin, requireAdmin, (request, response) => {
        const report = database.prepare(`
            SELECT id, target_type AS targetType, target_id AS targetId
            FROM reports WHERE id = ? AND status = 'open'
        `).get(request.params.id);
        if (!report) throw problem(404, "Ba a sami rahoto a buÉ—e ba.");
        const action = request.body?.action;
        if (!["dismiss", "resolve", "remove-content", "suspend-user"].includes(action)) {
            throw problem(400, "Matakin gudanarwa bai inganta ba.");
        }
        const timestamp = now();
        if (action === "suspend-user") {
            const userId = report.targetType === "user"
                ? report.targetId
                : database.prepare("SELECT author_id AS id FROM posts WHERE id = ?")
                    .get(report.targetId)?.id;
            if (!userId) throw problem(400, "Rahoton bai shafi asusun da za a dakatar ba.");
            database.prepare(`
                UPDATE users SET is_suspended = 1, session_version = session_version + 1,
                    updated_at = ? WHERE id = ?
            `).run(timestamp, userId);
        }
        if (action === "remove-content") {
            const target = report.targetType;
            if (target === "post") {
                const post = database.prepare("SELECT attachment_media_id AS mediaId FROM posts WHERE id = ?")
                    .get(report.targetId);
                deleteMediaRecord(post?.mediaId);
                database.prepare("UPDATE posts SET removed_at = ? WHERE id = ?").run(timestamp, report.targetId);
            } else if (target === "comment") {
                database.prepare("UPDATE comments SET removed_at = ? WHERE id = ?").run(timestamp, report.targetId);
            } else if (target === "message") {
                const message = database.prepare("SELECT attachment_media_id AS mediaId FROM messages WHERE id = ?")
                    .get(report.targetId);
                deleteMediaRecord(message?.mediaId);
                database.prepare(`
                    UPDATE messages SET content = '', movie_id = NULL, authorized_link = NULL,
                        attachment_media_id = NULL, deleted_at = ? WHERE id = ?
                `).run(timestamp, report.targetId);
            } else if (target === "group") {
                const media = database.prepare(`
                    SELECT attachment_media_id AS mediaId FROM group_messages
                    WHERE group_id = ? AND attachment_media_id IS NOT NULL
                `).all(report.targetId);
                for (const item of media) deleteMediaRecord(item.mediaId);
                database.prepare("DELETE FROM groups WHERE id = ?").run(report.targetId);
            } else {
                throw problem(400, "Wannan rahoto ba na cire post ko saÆ™o ba ne.");
            }
        }
        const status = action === "dismiss" ? "dismissed" : "resolved";
        database.prepare(`
            UPDATE reports SET status = ?, reviewed_at = ? WHERE id = ?
        `).run(status, timestamp, report.id);
        response.json({ status, action });
    });

    app.get("/api/admin/social/users", requireAdmin, (request, response) => {
        const users = database.prepare(`
            SELECT u.id, u.username, u.role, u.is_suspended AS isSuspended,
                u.can_create_groups AS canCreateGroups, u.created_at AS createdAt,
                p.full_name AS fullName
            FROM users u JOIN profiles p ON p.user_id = u.id
            ORDER BY u.created_at DESC LIMIT 200
        `).all();
        response.json({ users });
    });

    app.patch("/api/admin/social/users/:id", sameOrigin, requireAdmin, (request, response) => {
        const userId = idFrom(request.params.id, "Asusun");
        const user = database.prepare("SELECT id FROM users WHERE id = ?").get(userId);
        if (!user) throw problem(404, "Ba a sami asusun ba.");
        const role = request.body?.role;
        const suspended = request.body?.suspended;
        const canCreateGroups = request.body?.canCreateGroups;
        if (role !== undefined && !["user", "agent", "studio"].includes(role)) {
            throw problem(400, "Matsayin asusu bai inganta ba.");
        }
        if (suspended !== undefined && typeof suspended !== "boolean") {
            throw problem(400, "Matsayin dakatarwar asusu bai inganta ba.");
        }
        if (canCreateGroups !== undefined && typeof canCreateGroups !== "boolean") {
            throw problem(400, "Izinin Æ™irÆ™irar Æ™ungiya bai inganta ba.");
        }
        database.prepare(`
            UPDATE users SET role = COALESCE(?, role),
                is_suspended = COALESCE(?, is_suspended),
                can_create_groups = COALESCE(?, can_create_groups),
                session_version = session_version + CASE
                    WHEN ? IS NOT NULL AND ? != is_suspended THEN 1 ELSE 0 END,
                updated_at = ? WHERE id = ?
        `).run(
            role ?? null,
            suspended === undefined ? null : Number(suspended),
            canCreateGroups === undefined ? null : Number(canCreateGroups),
            suspended === undefined ? null : Number(suspended),
            suspended === undefined ? null : Number(suspended),
            now(),
            userId
        );
        response.json({ updated: true });
    });
}

module.exports = { createSocialRoutes, notifyStudioFollowers, cleanupSocialUpload };
