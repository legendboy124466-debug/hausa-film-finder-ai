const { spawn } = require("node:child_process");

function hashGrayPixels(pixels) {
    if (!Buffer.isBuffer(pixels) || pixels.length !== 72) {
        throw new TypeError("Image fingerprint requires exactly 72 decoded grayscale pixels.");
    }

    let hash = 0n;
    for (let y = 0; y < 8; y += 1) {
        for (let x = 0; x < 8; x += 1) {
            hash <<= 1n;
            if (pixels[y * 9 + x] > pixels[y * 9 + x + 1]) hash |= 1n;
        }
    }
    return hash.toString(16).padStart(16, "0");
}

function runFfmpeg(args, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg") {
    return new Promise((resolve, reject) => {
        const child = spawn(ffmpegPath, args, { windowsHide: true });
        const chunks = [];
        let length = 0;
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            length += chunk.length;
            if (length > 32 * 1024 * 1024) {
                child.kill();
                reject(new Error("FFmpeg image output exceeded the processing limit."));
                return;
            }
            chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk.toString()).slice(-8000);
        });
        child.on("error", (error) => {
            if (error.code === "ENOENT") {
                reject(new Error("FFmpeg is required for image and video fingerprints. Install FFmpeg and restart the server."));
            } else {
                reject(error);
            }
        });
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg failed to decode the image (${code}): ${stderr.trim()}`));
                return;
            }
            resolve(Buffer.concat(chunks));
        });
    });
}

async function createImageFingerprintFromFile(filePath) {
    const pixels = await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-i", filePath,
        "-frames:v", "1", "-vf", "scale=9:8:flags=area,format=gray",
        "-f", "rawvideo", "pipe:1"
    ]);
    return hashGrayPixels(pixels.subarray(0, 72));
}

module.exports = { hashGrayPixels, createImageFingerprintFromFile };