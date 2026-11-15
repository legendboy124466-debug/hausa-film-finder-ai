const { database, rowToMovie } = require("./database");
const {
    compareAudioFingerprints,
    compareImageFingerprints
} = require("../fingerprint/matcher");

const IMAGE_THRESHOLD = 0.91;
const AUDIO_THRESHOLD = 0.70;
const VIDEO_THRESHOLD = 0.78;
const CHROMAPRINT_FRAME_SECONDS = 1.48;

function movieForRecord(row) {
    return rowToMovie(row);
}

function imageMatch(hash) {
    const records = database.prepare(`
        SELECT f.movie_id, f.timestamp_seconds, f.hash,
            m.id, m.title, m.original_title, m.hausa_title, m.language, m.actors_json, m.description, m.country,
            m.year, m.studio, m.categories_json, m.episodes_json, m.duration_seconds,
            m.poster_path, m.poster_filename, m.permission_confirmed
        FROM fingerprints f JOIN movies m ON m.id = f.movie_id
        WHERE f.kind = 'image' AND m.permission_confirmed = 1
    `).all();
    const bestByMovie = new Map();
    for (const record of records) {
        const candidate = compareImageFingerprints(hash, [record]);
        const prior = bestByMovie.get(record.movie_id);
        if (!prior || candidate.score > prior.score) {
            bestByMovie.set(record.movie_id, {
                movie: movieForRecord(record),
                score: candidate.score,
                timestampSeconds: record.timestamp_seconds,
                modality: "image"
            });
        }
    }
    return [...bestByMovie.values()].sort((a, b) => b.score - a.score)[0] || null;
}

function visualVideoMatch(frames) {
    if (!Array.isArray(frames) || frames.length === 0) return null;
    const records = database.prepare(`
        SELECT f.movie_id, f.timestamp_seconds, f.hash,
            m.id, m.title, m.original_title, m.hausa_title, m.language, m.actors_json, m.description, m.country,
            m.year, m.studio, m.categories_json, m.episodes_json, m.duration_seconds,
            m.poster_path, m.poster_filename, m.permission_confirmed
        FROM fingerprints f JOIN movies m ON m.id = f.movie_id
        WHERE f.kind = 'image' AND m.permission_confirmed = 1
    `).all();
    const aggregates = new Map();
    for (const frame of frames) {
        const bestForFrame = new Map();
        for (const record of records) {
            const candidate = compareImageFingerprints(frame.hash, [record]);
            const prior = bestForFrame.get(record.movie_id);
            if (!prior || candidate.score > prior.score) {
                bestForFrame.set(record.movie_id, {
                    score: candidate.score,
                    timestampSeconds: record.timestamp_seconds,
                    movie: movieForRecord(record)
                });
            }
        }
        for (const [movieId, candidate] of bestForFrame) {
            const existing = aggregates.get(movieId) || {
                movie: candidate.movie,
                total: 0,
                count: 0,
                timestampSeconds: candidate.timestampSeconds
            };
            existing.total += candidate.score;
            existing.count += 1;
            if (candidate.score > (existing.bestScore || 0)) {
                existing.bestScore = candidate.score;
                existing.timestampSeconds = candidate.timestampSeconds;
            }
            aggregates.set(movieId, existing);
        }
    }
    return [...aggregates.values()]
        .map((candidate) => ({
            ...candidate,
            score: candidate.total / (candidate.count || 1),
            modality: "video"
        }))
        .sort((a, b) => b.score - a.score)[0] || null;
}

function audioMatch(rawFingerprint) {
    const records = database.prepare(`
        SELECT f.movie_id, f.timestamp_seconds, f.hash,
            m.id, m.title, m.original_title, m.hausa_title, m.language, m.actors_json, m.description, m.country,
            m.year, m.studio, m.categories_json, m.episodes_json, m.duration_seconds,
            m.poster_path, m.poster_filename, m.permission_confirmed
        FROM fingerprints f JOIN movies m ON m.id = f.movie_id
        WHERE f.kind = 'audio' AND m.permission_confirmed = 1
    `).all();
    const bestByMovie = new Map();
    for (const record of records) {
        const match = compareAudioFingerprints(rawFingerprint, record.hash);
        const prior = bestByMovie.get(record.movie_id);
        if (!prior || match.score > prior.score) {
            bestByMovie.set(record.movie_id, {
                movie: movieForRecord(record),
                score: match.score,
                timestampSeconds: record.timestamp_seconds + match.offset * CHROMAPRINT_FRAME_SECONDS,
                modality: "audio"
            });
        }
    }
    return [...bestByMovie.values()].sort((a, b) => b.score - a.score)[0] || null;
}

function combineVideoAndAudio(visual, audio) {
    if (!visual) return audio;
    if (!audio) return visual;
    if (visual.movie.id !== audio.movie.id) {
        if (visual.score >= VIDEO_THRESHOLD && audio.score >= AUDIO_THRESHOLD) return null;
        return visual.score >= VIDEO_THRESHOLD ? visual
            : audio.score >= AUDIO_THRESHOLD ? audio
                : visual.score >= audio.score ? visual : audio;
    }
    return {
        movie: visual.movie,
        score: visual.score * 0.55 + audio.score * 0.45,
        timestampSeconds: visual.score >= audio.score ? visual.timestampSeconds : audio.timestampSeconds,
        modality: "audio+video"
    };
}

function result(candidate, threshold) {
    if (!candidate || candidate.score < threshold) {
        return {
            identified: false,
            message: "Ba a iya gano fim ɗin da tabbaci daga fingerprints ɗin da aka adana ba."
        };
    }
    return {
        identified: true,
        movie: {
            id: candidate.movie.id,
            title: candidate.movie.title,
            originalTitle: candidate.movie.originalTitle,
            hausaTitle: candidate.movie.hausaTitle,
            description: candidate.movie.description,
            country: candidate.movie.country,
            year: candidate.movie.year,
            studio: candidate.movie.studio,
            episode: candidate.movie.episodes?.length === 1 ? candidate.movie.episodes[0] : null,
            episodes: candidate.movie.episodes || [],
            language: candidate.movie.language || "",
            actors: candidate.movie.actors || [],
            durationSeconds: candidate.movie.durationSeconds,
            posterUrl: candidate.movie.posterUrl,
            timestampSeconds: candidate.timestampSeconds,
            confidence: Math.round(candidate.score * 100),
            matchedBy: candidate.modality
        }
    };
}

module.exports = {
    imageMatch,
    visualVideoMatch,
    audioMatch,
    combineVideoAndAudio,
    result,
    IMAGE_THRESHOLD,
    AUDIO_THRESHOLD,
    VIDEO_THRESHOLD,
    AUDIO_VIDEO_THRESHOLD: 0.76
};
