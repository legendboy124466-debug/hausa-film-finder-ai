const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hausa-merlin-slot-link-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "merlin-slot-link.sqlite");
process.env.MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "movies");
process.env.MERLIN_MOVIE_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "movies", "merlin");
process.env.MERLIN_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "legacy-merlin");
process.env.POSTER_UPLOAD_DIR = path.join(temporaryDirectory, "uploads", "posters");
process.env.ADMIN_USERNAME = "merlin-slot-test-admin";
process.env.ADMIN_PASSWORD = "temporary-test-password-long-enough";
process.env.SESSION_SECRET = "temporary-test-secret-that-is-at-least-thirty-two-characters";

const originalLoadEnvFile = process.loadEnvFile;
process.loadEnvFile = () => {};
let registerMerlinEpisodeVideo;
let database;
try {
    ({ registerMerlinEpisodeVideo } = require("../backend/server"));
    ({ database } = require("../backend/database"));
} finally {
    process.loadEnvFile = originalLoadEnvFile;
}

before(() => {
    for (let episode = 1; episode <= 10; episode += 1) {
        registerMerlinEpisodeVideo(
            episode,
            `temporary-episode-${String(episode).padStart(2, "0")}.mp4`,
            "video/mp4",
            "temporary-test-time"
        );
    }
});

after(() => {
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("registers each Bulk Upload filename on its matching Season 1 episode slot", () => {
    const episodes = database.prepare(`
        SELECT episode_number, video_filename, video_mime_type
        FROM merlin_episodes ORDER BY episode_number
    `).all();

    assert.equal(episodes.length, 10);
    for (const [index, episode] of episodes.entries()) {
        const number = index + 1;
        assert.equal(episode.episode_number, number);
        assert.equal(episode.video_filename, `temporary-episode-${String(number).padStart(2, "0")}.mp4`);
        assert.equal(episode.video_mime_type, "video/mp4");
    }
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM fingerprints").get().count, 0);
});

test("does not replace an occupied slot or accept an invalid episode or filename", () => {
    const before = database.prepare(`
        SELECT video_filename, video_mime_type FROM merlin_episodes WHERE episode_number = 1
    `).get();

    assert.throws(
        () => registerMerlinEpisodeVideo(1, "replacement.mp4", "video/mp4", "later"),
        /already has a video/
    );
    assert.throws(
        () => registerMerlinEpisodeVideo(11, "episode.mp4", "video/mp4", "later"),
        /invalid/i
    );
    assert.throws(
        () => registerMerlinEpisodeVideo(2, "..\\outside.mp4", "video/mp4", "later"),
        /invalid/i
    );
    assert.deepEqual(database.prepare(`
        SELECT video_filename, video_mime_type FROM merlin_episodes WHERE episode_number = 1
    `).get(), before);
});
