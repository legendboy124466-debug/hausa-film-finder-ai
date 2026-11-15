const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

async function createAudioFingerprint(filePath, lengthSeconds = 120) {
    const fpcalcPath = process.env.FPCALC_PATH || "fpcalc";
    let output;
    try {
        ({ stdout: output } = await execFileAsync(fpcalcPath, [
            "-raw", "-length", String(lengthSeconds), filePath
        ], {
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            timeout: 120000
        }));
    } catch (error) {
        if (error.code === "ENOENT") {
            throw new Error("Chromaprint fpcalc is required for audio fingerprints. Install Chromaprint and restart the server.");
        }
        throw new Error(`Chromaprint could not process the audio: ${error.message}`);
    }

    const duration = Number(output.match(/^DURATION=(.+)$/m)?.[1]);
    const fingerprint = output.match(/^FINGERPRINT=(.+)$/m)?.[1]?.trim();
    if (!Number.isFinite(duration) || !fingerprint || !/^\d+(,\d+)*$/.test(fingerprint)) {
        throw new Error("Chromaprint returned an invalid raw fingerprint.");
    }
    return { duration, fingerprint };
}

module.exports = { createAudioFingerprint };