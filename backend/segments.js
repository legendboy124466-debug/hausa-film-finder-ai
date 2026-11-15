const SEGMENT_SECONDS = 4 * 60;

function splitDuration(durationSeconds, segmentSeconds = SEGMENT_SECONDS) {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
        throw new TypeError("Movie and segment durations must be positive finite values.");
    }

    const segments = [];
    for (let start = 0, number = 1; start < durationSeconds; start += segmentSeconds, number += 1) {
        segments.push({
            segmentNumber: number,
            startSeconds: start,
            endSeconds: Math.min(start + segmentSeconds, durationSeconds)
        });
    }
    return segments;
}

module.exports = { SEGMENT_SECONDS, splitDuration };
