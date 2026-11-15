function hammingDistance(left, right) {
    if (!/^[\da-f]{16}$/i.test(left) || !/^[\da-f]{16}$/i.test(right)) {
        throw new TypeError("Image hashes must be 64-bit hexadecimal values.");
    }
    let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
    let count = 0;
    while (bits) {
        count += Number(bits & 1n);
        bits >>= 1n;
    }
    return count;
}

function compareImageFingerprints(queryHash, storedRecords) {
    if (!Array.isArray(storedRecords)) return null;
    let best = null;
    for (const record of storedRecords) {
        const score = 1 - hammingDistance(queryHash, record.hash) / 64;
        if (!best || score > best.score) best = { ...record, score };
    }
    return best;
}

function parseChromaprint(raw) {
    if (typeof raw !== "string" || !/^\d+(,\d+)*$/.test(raw)) {
        throw new TypeError("Audio fingerprint must be a comma-separated Chromaprint integer sequence.");
    }
    return raw.split(",").map((value) => Number(value) >>> 0);
}

function compareAudioFingerprints(queryRaw, storedRaw) {
    const query = parseChromaprint(queryRaw);
    const stored = parseChromaprint(storedRaw);
    const queryIsShorter = query.length <= stored.length;
    const shorter = queryIsShorter ? query : stored;
    const longer = queryIsShorter ? stored : query;
    if (shorter.length < 4) return { score: 0, offset: 0 };

    let bestScore = 0;
    let bestOffset = 0;
    for (let offset = 0; offset <= longer.length - shorter.length; offset += 1) {
        let distance = 0;
        for (let index = 0; index < shorter.length; index += 1) {
            distance += popcount32(shorter[index] ^ longer[offset + index]);
        }
        const score = 1 - distance / (32 * shorter.length);
        if (score > bestScore) {
            bestScore = score;
            bestOffset = queryIsShorter ? offset : -offset;
        }
    }
    return { score: bestScore, offset: bestOffset };
}

function popcount32(value) {
    let bits = value >>> 0;
    bits -= (bits >>> 1) & 0x55555555;
    bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
    return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function findBestMatch(candidates, threshold) {
    if (!Array.isArray(candidates)) return null;
    return candidates
        .filter((candidate) => Number.isFinite(candidate.score) && candidate.score >= threshold)
        .sort((left, right) => right.score - left.score)[0] || null;
}

module.exports = {
    hammingDistance,
    compareImageFingerprints,
    compareAudioFingerprints,
    findBestMatch
};