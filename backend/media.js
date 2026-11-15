const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createAudioFingerprint } = require("../fingerprint/audio");
const { createImageFingerprintFromFile, hashGrayPixels } = require("../fingerprint/image");
const { extractVideoFingerprints } = require("../fingerprint/video");

const execFileAsync = promisify(execFile);
const playbackCopies = new Map();
const VISUAL_FRAME_BYTES = 72;
const MAX_AUDIO_FINGERPRINT_SECONDS = 120;
const MIN_AUDIO_FINGERPRINT_SECONDS = 8;

function audioWindowForSegment(startSeconds, durationSeconds, minimumSeconds = MIN_AUDIO_FINGERPRINT_SECONDS) {
    if (!Number.isFinite(startSeconds) || startSeconds < 0 ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
        !Number.isFinite(minimumSeconds) || minimumSeconds <= 0) {
        throw new TypeError("Audio segment times must be positive finite values.");
    }
    const extra = durationSeconds < minimumSeconds
        ? Math.min(minimumSeconds - durationSeconds, startSeconds)
        : 0;
    return {
        startSeconds: startSeconds - extra,
        durationSeconds: durationSeconds + extra,
        offsetSeconds: -extra
    };
}

async function extractSegmentFingerprints(filePath, startSeconds, durationSeconds, hasAudio) {
    if (!Number.isFinite(startSeconds) || startSeconds < 0 ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new TypeError("Movie segment times must be positive finite values.");
    }

    const audioWindow = hasAudio
        ? audioWindowForSegment(startSeconds, durationSeconds)
        : null;
    const inputStart = audioWindow
        ? Math.min(startSeconds, audioWindow.startSeconds)
        : startSeconds;
    const videoOffset = startSeconds - inputStart;
    const samplingInterval = Math.min(30, durationSeconds);
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hausa-film-segment-"));
    const videoOutputPath = path.join(temporaryDirectory, "visual.raw");
    const audioPattern = path.join(temporaryDirectory, "audio-%03d.wav");
    const filters = [
        `[0:v:0]trim=start=${videoOffset}:duration=${durationSeconds},setpts=PTS-STARTPTS,` +
        `fps=1/${samplingInterval},scale=9:8:flags=area,format=gray[visual]`
    ];
    if (audioWindow) {
        filters.push(`[0:a:0]atrim=duration=${audioWindow.durationSeconds},asetpts=PTS-STARTPTS[audio]`);
    }

    const args = [
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", String(inputStart), "-threads", "1", "-i", filePath,
        "-filter_complex", filters.join(";"),
        "-map", "[visual]", "-an", "-f", "rawvideo", videoOutputPath
    ];
    if (audioWindow) {
        args.push(
            "-map", "[audio]", "-vn", "-ac", "1", "-ar", "11025", "-c:a", "pcm_s16le",
            "-f", "segment", "-segment_time", String(MAX_AUDIO_FINGERPRINT_SECONDS),
            "-segment_format", "wav", "-reset_timestamps", "1", audioPattern
        );
    }

    try {
        const timeoutMs = Math.min(60 * 60 * 1000,
            Math.max(30 * 1000, Number(process.env.FINGERPRINT_FFMPEG_TIMEOUT_MS) || 15 * 60 * 1000));
        try {
            await execFileAsync(process.env.FFMPEG_PATH || "ffmpeg", args, {
                windowsHide: true,
                maxBuffer: 2 * 1024 * 1024,
                timeout: timeoutMs
            });
        } catch (error) {
            if (error.code === "ENOENT") {
                throw new Error("FFmpeg is required to extract visual and audio fingerprints.");
            }
            if (error.killed || error.code === "ETIMEDOUT") {
                throw new Error(`FFmpeg timed out while extracting a movie segment after ${Math.round(timeoutMs / 1000)} seconds.`);
            }
            throw new Error(`FFmpeg could not extract this movie segment: ${error.message}`);
        }

        const visualBytes = await fs.readFile(videoOutputPath);
        if (!visualBytes.length || visualBytes.length % VISUAL_FRAME_BYTES !== 0) {
            throw new Error("FFmpeg returned incomplete visual fingerprint frames.");
        }
        const visual = [];
        for (let offset = 0; offset < visualBytes.length; offset += VISUAL_FRAME_BYTES) {
            const hash = hashGrayPixels(visualBytes.subarray(offset, offset + VISUAL_FRAME_BYTES));
            visual.push({
                offsetSeconds: Math.min(visual.length * samplingInterval, durationSeconds),
                hash
            });
        }

        const audio = [];
        if (audioWindow) {
            const audioFiles = (await fs.readdir(temporaryDirectory))
                .filter((name) => /^audio-\d{3}\.wav$/.test(name))
                .sort();
            if (!audioFiles.length) throw new Error("FFmpeg returned no audio samples for this segment.");
            for (const [index, filename] of audioFiles.entries()) {
                const fingerprint = await createAudioFingerprint(
                    path.join(temporaryDirectory, filename), MAX_AUDIO_FINGERPRINT_SECONDS
                );
                if (!Number.isFinite(fingerprint.duration) || fingerprint.duration <= 0 ||
                    !/^\d+(,\d+)*$/.test(fingerprint.fingerprint || "")) {
                    throw new Error("Chromaprint returned an invalid audio fingerprint for this segment.");
                }
                audio.push({
                    offsetSeconds: audioWindow.offsetSeconds + index * MAX_AUDIO_FINGERPRINT_SECONDS,
                    durationSeconds: fingerprint.duration,
                    fingerprint: fingerprint.fingerprint
                });
            }
        }
        return { visual, audio };
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

async function probeFile(filePath) {
    const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
    let stdout;
    try {
        ({ stdout } = await execFileAsync(ffprobePath, [
            "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name",
            "-of", "json", filePath
        ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 120000 }));
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("FFprobe is required to inspect uploaded media. Install FFmpeg (including FFprobe) and restart the server.");
        }
        throw new Error(`FFprobe could not inspect the uploaded media: ${error.message}`);
    }

    let metadata;
    try {
        metadata = JSON.parse(stdout);
    } catch {
        throw new Error("FFprobe returned invalid media metadata.");
    }
    const duration = Number(metadata.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error("The uploaded media must have a valid duration.");
    }
    return {
        duration,
        hasVideo: metadata.streams?.some((stream) => stream.codec_type === "video") || false,
        hasAudio: metadata.streams?.some((stream) => stream.codec_type === "audio") || false,
        videoCodec: metadata.streams?.find((stream) => stream.codec_type === "video")?.codec_name || null,
        audioCodec: metadata.streams?.find((stream) => stream.codec_type === "audio")?.codec_name || null
    };
}

async function probeMedia(filePath) {
    const metadata = await probeFile(filePath);
    if (!metadata.hasVideo) throw new Error("The uploaded movie must contain a video stream.");
    return metadata;
}

async function probeAudio(filePath) {
    const metadata = await probeFile(filePath);
    if (!metadata.hasAudio) throw new Error("The uploaded audio sample does not contain an audio stream.");
    return metadata;
}

async function extractAudioFingerprints(filePath, startSeconds, durationSeconds) {
    const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "hausa-film-audio-"));
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    try {
        const results = [];
        for (let offset = 0; offset < durationSeconds; offset += 120) {
            let chunkStart = startSeconds + offset;
            let chunkDuration = Math.min(120, durationSeconds - offset);
            if (chunkDuration < 4 && offset > 0) {
                const extra = Math.min(4 - chunkDuration, offset);
                chunkStart -= extra;
                chunkDuration += extra;
            }
            const wavPath = path.join(tempDirectory, `segment-${offset}.wav`);
            try {
                await execFileAsync(ffmpegPath, [
                    "-hide_banner", "-loglevel", "error", "-y",
                    "-ss", String(chunkStart), "-i", filePath,
                    "-t", String(chunkDuration), "-vn", "-ac", "1",
                    "-ar", "11025", "-f", "wav", wavPath
                ], { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 15 * 60 * 1000 });
            } catch (error) {
                if (error.code === "ENOENT") {
                    throw new Error("FFmpeg is required to extract audio. Install FFmpeg and restart the server.");
                }
                throw new Error(`FFmpeg could not extract this segment's audio: ${error.message}`);
            }
            const fingerprint = await createAudioFingerprint(wavPath, 120);
            results.push({ offsetSeconds: chunkStart - startSeconds, ...fingerprint });
        }
        return results;
    } finally {
        await fs.rm(tempDirectory, { recursive: true, force: true });
    }
}

async function createSampleFingerprints(filePath, mediaInfo) {
    const visual = await extractVideoFingerprints(
        filePath,
        0,
        mediaInfo.duration,
        Math.max(2, Math.floor(mediaInfo.duration / 8))
    );
    let audio = null;
    if (mediaInfo.hasAudio) audio = await createAudioFingerprint(filePath, 120);
    return { visual, audio };
}

async function ensureChromePlayback(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    if (playbackCopies.has(filePath)) return playbackCopies.get(filePath);
    const media = await probeMedia(filePath);
    const chromeCompatibleContainer = extension === ".mp4" || extension === ".m4v";
    if (chromeCompatibleContainer && media.videoCodec === "h264" &&
        (!media.hasAudio || media.audioCodec === "aac")) {
        return filePath;
    }

    const conversion = (async () => {
        const outputPath = `${filePath}.chrome.mp4`;
        const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp.mp4`;
        try {
            const sourceStat = await fs.stat(filePath);
            try {
                const outputStat = await fs.stat(outputPath);
                if (outputStat.isFile() && outputStat.size > 0 &&
                    outputStat.mtimeMs >= sourceStat.mtimeMs) {
                    return outputPath;
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }

            const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
            try {
                await execFileAsync(ffmpegPath, [
                    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                    "-i", filePath, "-map", "0:v:0", "-map", "0:a:0?",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                    "-movflags", "+faststart", "-f", "mp4", temporaryPath
                ], {
                    windowsHide: true,
                    maxBuffer: 1024 * 1024,
                    timeout: 2 * 60 * 60 * 1000
                });
            } catch (error) {
                if (error.code === "ENOENT") {
                    const missingTool = new Error("FFmpeg is required to make this video playable in Chrome. Install FFmpeg and restart the server.");
                    missingTool.status = 503;
                    throw missingTool;
                }
                const conversionError = new Error("FFmpeg could not convert this movie into Chrome-compatible MP4 video with AAC audio.");
                conversionError.status = 422;
                throw conversionError;
            }

            const convertedStat = await fs.stat(temporaryPath);
            if (!convertedStat.isFile() || convertedStat.size === 0) {
                const conversionError = new Error("FFmpeg returned an empty playback copy.");
                conversionError.status = 422;
                throw conversionError;
            }
            await fs.rm(outputPath, { force: true });
            await fs.rename(temporaryPath, outputPath);
            return outputPath;
        } finally {
            await fs.rm(temporaryPath, { force: true });
        }
    })();

    playbackCopies.set(filePath, conversion);
    try {
        return await conversion;
    } finally {
        playbackCopies.delete(filePath);
    }
}

module.exports = {
    probeMedia,
    probeAudio,
    extractAudioFingerprints,
    extractSegmentFingerprints,
    audioWindowForSegment,
    createImageFingerprintFromFile,
    createSampleFingerprints,
    ensureChromePlayback
};
