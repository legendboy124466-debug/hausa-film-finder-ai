const { spawn } = require("node:child_process");
const { hashGrayPixels } = require("./image");

function extractVideoFingerprints(filePath, startSeconds, durationSeconds, intervalSeconds = 30) {
    if (!Number.isFinite(startSeconds) || startSeconds < 0 ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
        return Promise.reject(new TypeError("Video segment times must be positive finite values."));
    }

    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const samplingInterval = Math.min(intervalSeconds, durationSeconds);
    const args = [
        "-hide_banner", "-loglevel", "error", "-ss", String(startSeconds),
        "-i", filePath, "-t", String(durationSeconds), "-an",
        "-vf", `fps=1/${samplingInterval},scale=9:8:flags=area,format=gray`,
        "-f", "rawvideo", "pipe:1"
    ];

    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        const chunks = [];
        let outputLength = 0;
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            outputLength += chunk.length;
            if (outputLength > 8 * 1024 * 1024) {
                child.kill();
                reject(new Error("Video segment frame output exceeded its limit."));
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-8000);
        });
        child.on("error", (error) => {
            if (error.code === "ENOENT") {
                reject(new Error("FFmpeg is required for video fingerprints. Install FFmpeg and restart the server."));
            } else {
                reject(error);
            }
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg could not decode the video segment (${code}): ${stderr.trim()}`));
                return;
            }
            const raw = Buffer.concat(chunks);
            const fingerprints = [];
            for (let offset = 0; offset + 72 <= raw.length; offset += 72) {
                fingerprints.push({
                    offsetSeconds: Math.min(fingerprints.length * samplingInterval, durationSeconds),
                    hash: hashGrayPixels(raw.subarray(offset, offset + 72))
                });
            }
            resolve(fingerprints);
        });
    });
}

module.exports = { extractVideoFingerprints };
