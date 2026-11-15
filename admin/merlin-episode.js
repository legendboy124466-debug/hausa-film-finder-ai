(function exposeMerlinEpisodeParser(root, factory) {
    const parseEpisodeNumber = factory();
    if (typeof module === "object" && module.exports) module.exports = parseEpisodeNumber;
    if (root) root.merlinEpisodeNumberFromFilename = parseEpisodeNumber;
})(typeof window === "undefined" ? globalThis : window, function createParser() {
    return function merlinEpisodeNumberFromFilename(filename) {
        if (typeof filename !== "string") return null;
        const name = filename.replace(/\.[^.]+$/, "").trim();
        const validNumber = "(10|0?[1-9])";
        const patterns = [
            new RegExp(`\\bs\\d{1,3}\\s*[-_. ]*e(?:pisode|pison|p)?[\\s._-]*${validNumber}(?=\\D|$)`, "i"),
            new RegExp(`\\bseason\\s*\\d{1,3}\\s*[-_. ]*(?:episode|epison|ep)[\\s._-]*${validNumber}(?=\\D|$)`, "i"),
            new RegExp(`\\b(?:episode|epison|ep)[\\s._-]*${validNumber}(?=\\D|$)`, "i"),
            new RegExp(`\\bfita(?:\\s+ta)?[\\s._-]*${validNumber}(?=\\D|$)`, "i"),
            new RegExp(`\\b(?:merlin|marlin)[\\s._-]+${validNumber}$`, "i")
        ];
        for (const pattern of patterns) {
            const match = name.match(pattern);
            if (match) return Number(match[1]);
        }
        return null;
    };
});
