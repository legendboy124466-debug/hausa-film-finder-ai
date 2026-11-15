const { database } = require("./database");
const { extractAudioFingerprints, probeMedia } = require("./media");
const { extractVideoFingerprints } = require("../fingerprint/video");
const { splitDuration } = require("./segments");

const activeJobs = new Set();
const queue = [];
let draining = false;

function enqueueJob(jobId) {
    if (activeJobs.has(jobId) || queue.includes(jobId)) return;
    queue.push(jobId);
    void drainQueue();
}

async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
        while (queue.length) {
            const jobId = queue.shift();
            activeJobs.add(jobId);
            try {
                await processJob(jobId);
            } finally {
                activeJobs.delete(jobId);
            }
        }
    } finally {
        draining = false;
        if (queue.length) void drainQueue();
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

function updateJobCounts(jobId, movieId, status, error = null) {
    const counts = getProgressCounts(movieId);
    database.prepare(`
        UPDATE processing_jobs
        SET status = ?, completed_segments = ?, failed_segments = ?,
            error = ?, updated_at = ?
        WHERE id = ?
    `).run(status, counts.completed || 0, counts.failed || 0, error, new Date().toISOString(), jobId);
}

function verifyFingerprints(movieId, expectedSegments, hasAudio) {
    if (!Number.isInteger(expectedSegments) || expectedSegments < 1) return false;
    const segments = database.prepare(`
        SELECT s.segment_number, s.status,
            SUM(CASE WHEN f.kind = 'image' AND length(trim(f.hash)) > 0 THEN 1 ELSE 0 END) AS images,
            SUM(CASE WHEN f.kind = 'audio' AND length(trim(f.hash)) > 0 THEN 1 ELSE 0 END) AS audio
        FROM segments s
        LEFT JOIN fingerprints f
            ON f.movie_id = s.movie_id AND f.segment_number = s.segment_number
        WHERE s.movie_id = ?
        GROUP BY s.segment_number, s.status
    `).all(movieId);
    return segments.length === expectedSegments && segments.every((segment) =>
        segment.status === "completed" &&
        segment.images > 0 &&
        (!hasAudio || segment.audio > 0)
    );
}

async function processJob(jobId) {
    const job = database.prepare("SELECT * FROM processing_jobs WHERE id = ?").get(jobId);
    const movie = job && database.prepare("SELECT * FROM movies WHERE id = ?").get(job.movie_id);
    if (!job || !movie || !movie.movie_path) return;

    try {
        const media = await probeMedia(movie.movie_path);
        const maxDuration = Number(process.env.MAX_MOVIE_DURATION_SECONDS || 43200);
        if (media.duration > maxDuration) {
            throw new Error(`Movie duration exceeds the configured limit of ${maxDuration} seconds.`);
        }
        const segments = splitDuration(media.duration);
        const now = new Date().toISOString();
        database.prepare(`
            UPDATE movies SET duration_seconds = ?, has_audio = ?, updated_at = ? WHERE id = ?
        `).run(media.duration, media.hasAudio ? 1 : 0, now, movie.id);
        database.prepare(`
            UPDATE processing_jobs SET status = 'processing', duration_seconds = ?,
                total_segments = ?, error = NULL, updated_at = ? WHERE id = ?
        `).run(media.duration, segments.length, now, jobId);
        const createSegment = database.prepare(`
            INSERT OR IGNORE INTO segments (
                movie_id, segment_number, start_seconds, end_seconds, status, updated_at
            ) VALUES (?, ?, ?, ?, 'waiting', ?)
        `);
        for (const segment of segments) {
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
                updateJobCounts(jobId, movie.id, "paused");
                return;
            }

            database.prepare(`
                UPDATE segments SET status = 'processing', attempts = attempts + 1,
                    error = NULL, updated_at = ? WHERE movie_id = ? AND segment_number = ?
            `).run(new Date().toISOString(), movie.id, segment.segment_number);
            try {
                const duration = segment.end_seconds - segment.start_seconds;
                const visual = await extractVideoFingerprints(
                    movie.movie_path, segment.start_seconds, duration, 30
                );
                if (!visual.length) throw new Error("No representative video frames were decoded.");
                const audio = media.hasAudio
                    ? await extractAudioFingerprints(movie.movie_path, segment.start_seconds, duration)
                    : null;
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
                    if (audio) {
                        for (const audioPart of audio) {
                            insertFingerprint.run(
                                movie.id, segment.segment_number, "audio",
                                segment.start_seconds + audioPart.offsetSeconds,
                                audioPart.fingerprint, createdAt
                            );
                        }
                    }
                    database.prepare(`
                        UPDATE segments SET status = 'completed', error = NULL, updated_at = ?
                        WHERE movie_id = ? AND segment_number = ?
                    `).run(createdAt, movie.id, segment.segment_number);
                    const counts = getProgressCounts(movie.id);
                    database.prepare(`
                        UPDATE processing_jobs SET completed_segments = ?, failed_segments = ?,
                            updated_at = ? WHERE id = ?
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
                updateJobCounts(jobId, movie.id, "processing");
            }
        }

        const counts = getProgressCounts(movie.id);
        const verified = verifyFingerprints(movie.id, segments.length, media.hasAudio);
        updateJobCounts(
            jobId,
            movie.id,
            counts.failed || !verified ? "failed" : "completed",
            verified ? null : "Fingerprint verification failed: every segment must contain verified visual fingerprints and, when present, audio fingerprints."
        );
    } catch (error) {
        const detail = String(error.message || "Movie processing failed").slice(0, 1000);
        updateJobCounts(jobId, movie.id, "failed", detail);
    }
}

function resumeInterruptedJobs() {
    database.prepare(`
        UPDATE segments SET status = 'waiting', updated_at = ?
        WHERE status = 'processing'
    `).run(new Date().toISOString());
    const interrupted = database.prepare(`
        SELECT id FROM processing_jobs WHERE status = 'processing'
    `).all();
    for (const job of interrupted) {
        database.prepare(`
            UPDATE processing_jobs SET status = 'waiting', pause_requested = 0, updated_at = ?
            WHERE id = ?
        `).run(new Date().toISOString(), job.id);
        enqueueJob(job.id);
    }
    const waiting = database.prepare("SELECT id FROM processing_jobs WHERE status = 'waiting'").all();
    for (const job of waiting) enqueueJob(job.id);
}

module.exports = { enqueueJob, resumeInterruptedJobs, processJob, verifyFingerprints };
