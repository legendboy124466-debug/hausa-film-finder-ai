const fs = require("node:fs/promises");
const { database } = require("./database");
const { extractSegmentFingerprints, probeMedia } = require("./media");
const { splitDuration } = require("./segments");

const activeJobs = new Set();
const queue = [];
let draining = false;

function getMaxConcurrentJobs() {
    const configured = Number(process.env.FINGERPRINT_MAX_CONCURRENT_JOBS || 1);
    return Number.isInteger(configured) ? Math.min(2, Math.max(1, configured)) : 1;
}

function enqueueJob(jobId) {
    if (!jobId || activeJobs.has(jobId) || queue.includes(jobId)) return;
    queue.push(jobId);
    drainQueue();
}

function drainQueue() {
    if (draining) return;
    draining = true;
    try {
        while (queue.length && activeJobs.size < getMaxConcurrentJobs()) {
            const jobId = queue.shift();
            activeJobs.add(jobId);
            void Promise.resolve()
                .then(() => processJob(jobId))
                .catch((error) => {
                    const detail = String(error.message || "Unexpected fingerprint worker error").slice(0, 1000);
                    database.prepare(`
                        UPDATE processing_jobs SET status = 'failed', processing_stage = 'failed',
                            error = ?, updated_at = ? WHERE id = ? AND status = 'processing'
                    `).run(detail, new Date().toISOString(), jobId);
                })
                .finally(() => {
                    activeJobs.delete(jobId);
                    drainQueue();
                });
        }
    } finally {
        draining = false;
    }
}

function getProgressCounts(movieId) {
    return database.prepare(`
        SELECT
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM segments WHERE movie_id = ?
    `).get(movieId);
}

function updateJobCounts(jobId, movieId, status, error = null, stage = status) {
    const counts = getProgressCounts(movieId);
    database.prepare(`
        UPDATE processing_jobs
        SET status = ?, processing_stage = ?, completed_segments = ?, failed_segments = ?,
            error = ?, updated_at = ?
        WHERE id = ?
    `).run(status, stage, counts.completed || 0, counts.failed || 0,
        error, new Date().toISOString(), jobId);
}

function validFingerprint(kind, hash) {
    if (kind === "image") return /^[a-f0-9]{16}$/i.test(hash || "");
    if (kind === "audio") return /^\d+(,\d+)*$/.test(hash || "");
    return false;
}

function verifySegmentFingerprints(movieId, segmentNumber, hasAudio) {
    const movie = database.prepare("SELECT duration_seconds FROM movies WHERE id = ?").get(movieId);
    const rows = database.prepare(`
        SELECT kind, timestamp_seconds, hash
        FROM fingerprints WHERE movie_id = ? AND segment_number = ?
    `).all(movieId, segmentNumber);
    const images = rows.filter((row) => row.kind === "image");
    const audio = rows.filter((row) => row.kind === "audio");
    const validRows = rows.every((row) => Number.isFinite(row.timestamp_seconds) &&
        row.timestamp_seconds >= 0 &&
        (!Number.isFinite(movie?.duration_seconds) || row.timestamp_seconds <= movie.duration_seconds + 0.001) &&
        validFingerprint(row.kind, row.hash));
    return validRows && images.length > 0 && (!hasAudio || audio.length > 0);
}

function verifyFingerprints(movieId, expectedSegments, hasAudio) {
    if (!Number.isInteger(expectedSegments) || expectedSegments < 1) return false;
    const segments = database.prepare(`
        SELECT segment_number, status FROM segments
        WHERE movie_id = ? ORDER BY segment_number
    `).all(movieId);
    if (segments.length !== expectedSegments ||
        segments.some((segment, index) => segment.segment_number !== index + 1 || segment.status !== "completed")) {
        return false;
    }
    return segments.every((segment) =>
        verifySegmentFingerprints(movieId, segment.segment_number, hasAudio)
    );
}

function claimJob(jobId) {
    database.exec("BEGIN IMMEDIATE");
    try {
        const job = database.prepare(`
            SELECT * FROM processing_jobs WHERE id = ? AND status = 'waiting'
        `).get(jobId);
        if (!job) {
            database.exec("ROLLBACK");
            return null;
        }
        database.prepare(`
            UPDATE processing_jobs SET status = 'processing', processing_stage = 'probing',
                pause_requested = 0, error = NULL, updated_at = ?
            WHERE id = ? AND status = 'waiting'
        `).run(new Date().toISOString(), jobId);
        database.exec("COMMIT");
        return job;
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function segmentLayoutMatches(existing, expected) {
    if (existing.length !== expected.length) return false;
    return existing.every((segment, index) =>
        segment.segment_number === expected[index].segmentNumber &&
        Math.abs(segment.start_seconds - expected[index].startSeconds) < 0.001 &&
        Math.abs(segment.end_seconds - expected[index].endSeconds) < 0.001
    );
}

async function processJob(jobId) {
    let claimedJob;
    try {
        claimedJob = claimJob(jobId);
        if (!claimedJob) return;
        const movie = database.prepare("SELECT * FROM movies WHERE id = ?").get(claimedJob.movie_id);
        if (!movie || !movie.movie_path) {
            updateJobCounts(jobId, claimedJob.movie_id, "failed",
                "The movie record or uploaded movie file is missing.", "failed");
            return;
        }

        const movieStat = await fs.stat(movie.movie_path);
        if (!movieStat.isFile()) throw new Error("The uploaded movie path is not a regular file.");
        const cachedMetadataValid = Number.isFinite(claimedJob.duration_seconds) &&
            claimedJob.total_segments > 0 && claimedJob.media_size_bytes === movieStat.size &&
            Number.isFinite(claimedJob.media_mtime_ms) &&
            Math.abs(claimedJob.media_mtime_ms - movieStat.mtimeMs) < 1 &&
            Number.isFinite(movie.duration_seconds) &&
            Math.abs(movie.duration_seconds - claimedJob.duration_seconds) < 0.001;
        if (!cachedMetadataValid) {
            database.prepare(`
                UPDATE processing_jobs SET processing_stage = 'probing media metadata', updated_at = ? WHERE id = ?
            `).run(new Date().toISOString(), jobId);
        }
        const media = cachedMetadataValid
            ? { duration: claimedJob.duration_seconds, hasAudio: Boolean(movie.has_audio) }
            : await probeMedia(movie.movie_path);
        const maxDuration = Number(process.env.MAX_MOVIE_DURATION_SECONDS || 43200);
        if (media.duration > maxDuration) {
            throw new Error(`Movie duration exceeds the configured limit of ${maxDuration} seconds.`);
        }
        const expectedSegments = splitDuration(media.duration);
        const existingSegments = database.prepare(`
            SELECT segment_number, start_seconds, end_seconds, status
            FROM segments WHERE movie_id = ? ORDER BY segment_number
        `).all(movie.id);
        if (existingSegments.length && !segmentLayoutMatches(existingSegments, expectedSegments)) {
            throw new Error("Stored segment boundaries do not match the current movie duration; completed work was preserved.");
        }

        const now = new Date().toISOString();
        database.prepare(`
            UPDATE movies SET duration_seconds = ?, has_audio = ?, updated_at = ? WHERE id = ?
        `).run(media.duration, media.hasAudio ? 1 : 0, now, movie.id);
        database.prepare(`
            UPDATE processing_jobs SET duration_seconds = ?, total_segments = ?,
                media_size_bytes = ?, media_mtime_ms = ?,
                processing_stage = 'fingerprinting', error = NULL, updated_at = ? WHERE id = ?
        `).run(media.duration, expectedSegments.length, movieStat.size, movieStat.mtimeMs, now, jobId);

        const createSegment = database.prepare(`
            INSERT OR IGNORE INTO segments (
                movie_id, segment_number, start_seconds, end_seconds, status, updated_at
            ) VALUES (?, ?, ?, ?, 'waiting', ?)
        `);
        for (const segment of expectedSegments) {
            createSegment.run(movie.id, segment.segmentNumber, segment.startSeconds, segment.endSeconds, now);
        }

        const pending = database.prepare(`
            SELECT * FROM segments
            WHERE movie_id = ? AND status != 'completed'
            ORDER BY segment_number
        `).all(movie.id);

        for (const segment of pending) {
            const latestJob = database.prepare("SELECT pause_requested FROM processing_jobs WHERE id = ?").get(jobId);
            if (!latestJob || latestJob.pause_requested) {
                updateJobCounts(jobId, movie.id, "paused", null, "paused");
                return;
            }

            database.prepare(`
                UPDATE segments SET status = 'processing', attempts = attempts + 1,
                    error = NULL, updated_at = ? WHERE movie_id = ? AND segment_number = ?
            `).run(new Date().toISOString(), movie.id, segment.segment_number);
            database.prepare(`
                UPDATE processing_jobs SET processing_stage = ?, updated_at = ? WHERE id = ?
            `).run(`fingerprinting segment ${segment.segment_number}/${expectedSegments.length}`,
                new Date().toISOString(), jobId);

            try {
                const duration = segment.end_seconds - segment.start_seconds;
                const { visual, audio } = await extractSegmentFingerprints(
                    movie.movie_path, segment.start_seconds, duration, media.hasAudio
                );
                if (!visual.length || visual.some((frame) =>
                    !Number.isFinite(frame.offsetSeconds) || !validFingerprint("image", frame.hash))) {
                    throw new Error("No valid representative visual fingerprints were generated for this segment.");
                }
                if (media.hasAudio && (!audio.length || audio.some((part) =>
                    !Number.isFinite(part.offsetSeconds) || !validFingerprint("audio", part.fingerprint)))) {
                    throw new Error("No valid audio fingerprints were generated for this segment.");
                }

                const insertFingerprint = database.prepare(`
                    INSERT OR IGNORE INTO fingerprints (
                        movie_id, segment_number, kind, timestamp_seconds, hash, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                `);
                database.exec("BEGIN IMMEDIATE");
                try {
                    const createdAt = new Date().toISOString();
                    for (const frame of visual) {
                        insertFingerprint.run(
                            movie.id, segment.segment_number, "image",
                            segment.start_seconds + frame.offsetSeconds, frame.hash, createdAt
                        );
                    }
                    for (const audioPart of audio) {
                        insertFingerprint.run(
                            movie.id, segment.segment_number, "audio",
                            segment.start_seconds + audioPart.offsetSeconds,
                            audioPart.fingerprint, createdAt
                        );
                    }
                    if (!verifySegmentFingerprints(movie.id, segment.segment_number, media.hasAudio)) {
                        throw new Error("Stored fingerprints did not pass segment verification.");
                    }
                    database.prepare(`
                        UPDATE segments SET status = 'completed', error = NULL, updated_at = ?
                        WHERE movie_id = ? AND segment_number = ?
                    `).run(createdAt, movie.id, segment.segment_number);
                    const counts = getProgressCounts(movie.id);
                    database.prepare(`
                        UPDATE processing_jobs SET completed_segments = ?, failed_segments = ?,
                            processing_stage = 'fingerprinting', updated_at = ? WHERE id = ?
                    `).run(counts.completed || 0, counts.failed || 0, createdAt, jobId);
                    database.exec("COMMIT");
                } catch (error) {
                    database.exec("ROLLBACK");
                    throw error;
                }
            } catch (error) {
                const detail = String(error.message || "Unknown segment processing error").slice(0, 1000);
                database.prepare(`
                    UPDATE segments SET status = 'failed', error = ?, updated_at = ?
                    WHERE movie_id = ? AND segment_number = ?
                `).run(detail, new Date().toISOString(), movie.id, segment.segment_number);
                updateJobCounts(jobId, movie.id, "processing", detail,
                    `failed segment ${segment.segment_number}; continuing`);
            }
        }

        const counts = getProgressCounts(movie.id);
        const verified = verifyFingerprints(movie.id, expectedSegments.length, media.hasAudio);
        const failedSegment = counts.failed
            ? database.prepare(`
                SELECT error FROM segments WHERE movie_id = ? AND status = 'failed'
                ORDER BY segment_number LIMIT 1
            `).get(movie.id)
            : null;
        const complete = !counts.failed && verified;
        const finalError = complete ? null : failedSegment?.error ||
            "Fingerprint verification failed: every segment must contain valid stored visual fingerprints and, when present, audio fingerprints.";
        updateJobCounts(jobId, movie.id, complete ? "completed" : "failed", finalError,
            complete ? "completed" : "failed");
    } catch (error) {
        const detail = String(error.message || "Movie processing failed").slice(0, 1000);
        if (claimedJob) updateJobCounts(jobId, claimedJob.movie_id, "failed", detail, "failed");
    }
}

function retryJob(jobId) {
    database.exec("BEGIN IMMEDIATE");
    try {
        const job = database.prepare(`
            SELECT id, movie_id, status FROM processing_jobs WHERE id = ?
        `).get(jobId);
        if (!job) {
            database.exec("ROLLBACK");
            return false;
        }
        if (!["failed", "paused"].includes(job.status)) {
            database.exec("ROLLBACK");
            return false;
        }
        const movie = database.prepare(`
            SELECT has_audio FROM movies WHERE id = ?
        `).get(job.movie_id);
        const completedSegments = database.prepare(`
            SELECT segment_number FROM segments
            WHERE movie_id = ? AND status = 'completed'
        `).all(job.movie_id);
        for (const segment of completedSegments) {
            if (!verifySegmentFingerprints(job.movie_id, segment.segment_number, Boolean(movie?.has_audio))) {
                database.prepare(`
                    UPDATE segments SET status = 'failed', error = 'Stored fingerprints failed verification.', updated_at = ?
                    WHERE movie_id = (SELECT movie_id FROM processing_jobs WHERE id = ?) AND segment_number = ?
                `).run(new Date().toISOString(), job.movie_id, segment.segment_number);
            }
        }
        const now = new Date().toISOString();
        database.prepare(`
            UPDATE segments SET status = 'waiting', error = NULL, updated_at = ?
            WHERE movie_id = (SELECT movie_id FROM processing_jobs WHERE id = ?)
                AND status IN ('failed', 'processing')
        `).run(now, jobId);
        database.prepare(`
            UPDATE processing_jobs SET status = 'waiting', processing_stage = 'pending',
                completed_segments = (
                    SELECT COUNT(*) FROM segments
                    WHERE movie_id = (SELECT movie_id FROM processing_jobs WHERE id = ?) AND status = 'completed'
                ),
                failed_segments = (
                    SELECT COUNT(*) FROM segments
                    WHERE movie_id = (SELECT movie_id FROM processing_jobs WHERE id = ?) AND status = 'failed'
                ),
                pause_requested = 0, error = NULL, updated_at = ? WHERE id = ?
        `).run(jobId, jobId, now, jobId);
        database.exec("COMMIT");
        enqueueJob(jobId);
        return true;
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

function resumeInterruptedJobs() {
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
        database.prepare(`
            UPDATE segments SET status = 'waiting', updated_at = ?
            WHERE status = 'processing'
        `).run(now);
        database.prepare(`
            UPDATE processing_jobs SET status = 'waiting', processing_stage = 'pending',
                pause_requested = 0, updated_at = ? WHERE status = 'processing'
        `).run(now);
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
    const waiting = database.prepare("SELECT id FROM processing_jobs WHERE status = 'waiting'").all();
    for (const job of waiting) enqueueJob(job.id);
}

module.exports = {
    enqueueJob,
    resumeInterruptedJobs,
    processJob,
    retryJob,
    verifyFingerprints,
    verifySegmentFingerprints,
    getMaxConcurrentJobs
};
