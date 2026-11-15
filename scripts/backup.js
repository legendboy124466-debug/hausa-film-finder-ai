#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const MANIFEST_NAME = "manifest.json";

function fail(message) {
    throw new Error(message);
}

function parseOptions(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const key = args[index];
        if (!key.startsWith("--") || !args[index + 1] || args[index + 1].startsWith("--")) {
            fail("Use options as --name value.");
        }
        const name = key.slice(2);
        if (Object.hasOwn(options, name)) fail(`Option --${name} was supplied more than once.`);
        options[name] = args[++index];
    }
    return options;
}

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveInput(value, fallback) {
    return path.resolve(value || fallback);
}

function getBackupInputs(options) {
    const database = resolveInput(options.database || process.env.DATABASE_PATH,
        path.join(projectRoot, "backend", "data", "hausa-film-finder.sqlite"));
    const movieDir = resolveInput(options.movies || process.env.MOVIE_UPLOAD_DIR,
        path.join(projectRoot, "uploads", "movies"));
    return {
        database,
        media: [
            ["movies", movieDir],
            ["posters", resolveInput(options.posters || process.env.POSTER_UPLOAD_DIR,
                path.join(projectRoot, "uploads", "posters"))],
            ["merlin", resolveInput(options.merlin || process.env.MERLIN_UPLOAD_DIR,
                path.join(projectRoot, "uploads", "merlin"))],
            ["social", resolveInput(options.social || process.env.SOCIAL_UPLOAD_DIR,
                path.join(projectRoot, "uploads", "social"))],
            ["merlin_movies", resolveInput(options["merlin-movies"] || process.env.MERLIN_MOVIE_UPLOAD_DIR,
                path.join(movieDir, "merlin"))]
        ]
    };
}

function getSqliteCli() {
    return process.env.SQLITE3_PATH || "sqlite3";
}

function sqliteBackup(source, destination) {
    const destinationLiteral = destination.replace(/'/g, "''");
    execFileSync(getSqliteCli(), ["-readonly", source, `.backup '${destinationLiteral}'`], {
        stdio: "ignore",
        windowsHide: true
    });
}

function verifyDatabase(databasePath) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
        const integrity = database.prepare("PRAGMA integrity_check").all();
        if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
            fail("SQLite integrity_check failed.");
        }
        if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
            fail("SQLite foreign_key_check found violations.");
        }
    } finally {
        database.close();
    }
}

function hashFile(filePath) {
    return new Promise((resolve, reject) => {
        const digest = crypto.createHash("sha256");
        let bytes = 0;
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => {
            bytes += chunk.length;
            digest.update(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve({ bytes, sha256: digest.digest("hex") }));
    });
}

function copyTree(source, destination, relativePrefix, fileList) {
    const info = fs.lstatSync(source);
    if (info.isSymbolicLink()) fail("Media directories cannot contain symbolic links.");
    if (info.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        fs.chmodSync(destination, 0o700);
        for (const entry of fs.readdirSync(source).sort()) {
            copyTree(path.join(source, entry), path.join(destination, entry),
                path.posix.join(relativePrefix, entry), fileList);
        }
        return;
    }
    if (!info.isFile()) fail("Media directories can contain only regular files and directories.");
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    fileList.push(relativePrefix);
}

function walkFiles(directory, prefix = "") {
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path.posix.join(prefix, entry.name);
        const filePath = path.join(directory, entry.name);
        const info = fs.lstatSync(filePath);
        if (info.isSymbolicLink()) fail("Backup bundles cannot contain symbolic links.");
        if (info.isDirectory()) files.push(...walkFiles(filePath, relative));
        else if (info.isFile()) files.push(relative);
        else fail("Backup bundles can contain only regular files and directories.");
    }
    return files;
}

function safeBundlePath(bundleRoot, relativePath) {
    if (typeof relativePath !== "string" || !relativePath || path.posix.isAbsolute(relativePath) ||
        relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
        fail("Backup manifest contains an unsafe file path.");
    }
    const target = path.resolve(bundleRoot, ...relativePath.split("/"));
    if (!inside(bundleRoot, target) || target === bundleRoot) fail("Backup manifest path escapes its folder.");
    return target;
}

async function buildFileManifest(bundleRoot, relativePaths) {
    const entries = [];
    for (const relativePath of [...new Set(relativePaths)].sort()) {
        const filePath = safeBundlePath(bundleRoot, relativePath);
        const info = fs.lstatSync(filePath);
        if (!info.isFile() || info.isSymbolicLink()) fail("A backup entry is not a regular file.");
        entries.push({ path: relativePath, ...(await hashFile(filePath)) });
    }
    return entries;
}

async function verifyManifestFiles(bundleRoot, manifest) {
    if (!Array.isArray(manifest.files) || !manifest.files.length) fail("Backup manifest has no file list.");
    const expected = new Map();
    for (const entry of manifest.files) {
        if (!entry || typeof entry.path !== "string" || !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || expected.has(entry.path)) {
            fail("Backup manifest contains an invalid file record.");
        }
        expected.set(entry.path, entry);
    }
    const actual = walkFiles(bundleRoot).filter((file) => file !== MANIFEST_NAME).sort();
    const listed = [...expected.keys()].sort();
    if (JSON.stringify(actual) !== JSON.stringify(listed)) fail("Backup file list does not match its manifest.");
    for (const entry of expected.values()) {
        const actualHash = await hashFile(safeBundlePath(bundleRoot, entry.path));
        if (actualHash.bytes !== entry.bytes || actualHash.sha256 !== entry.sha256) {
            fail("Backup SHA-256 validation failed.");
        }
    }
}

function parseManifest(bundleRoot) {
    const manifestPath = path.join(bundleRoot, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) fail("Backup manifest is missing.");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.format !== "hausa-film-finder-backup" || manifest.version !== 1 ||
        !Array.isArray(manifest.media_roots)) fail("Backup manifest format is unsupported.");
    return manifest;
}

function createStage(parent, label) {
    const stage = path.join(parent, `.${label}-partial-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    fs.mkdirSync(stage, { recursive: false, mode: 0o700 });
    return stage;
}

async function createBackup(options) {
    if (process.env.HF_BACKUP_QUIESCED !== "YES") {
        fail("Stop the application first and set HF_BACKUP_QUIESCED=YES for a consistent database/media backup.");
    }
    const destinationRoot = path.resolve(options.destination || "");
    if (!options.destination || !fs.existsSync(destinationRoot) || !fs.statSync(destinationRoot).isDirectory()) {
        fail("Choose an existing backup destination directory.");
    }
    const inputs = getBackupInputs(options);
    if (!fs.existsSync(inputs.database) || !fs.statSync(inputs.database).isFile()) fail("Configured SQLite database was not found.");
    for (const [, mediaPath] of inputs.media) {
        if (!fs.existsSync(mediaPath) || !fs.statSync(mediaPath).isDirectory()) {
            fail("A required persistent media directory is missing.");
        }
    }
    if (inputs.media.some(([, mediaPath]) => inside(mediaPath, destinationRoot))) {
        fail("Backup destination cannot be inside a media directory.");
    }
    if (inside(destinationRoot, inputs.database)) fail("Backup destination cannot contain the source database.");
    if (process.env.HF_BACKUP_REQUIRE_SEPARATE_DEVICE === "1" &&
        fs.statSync(destinationRoot).dev === fs.statSync(inputs.database).dev) {
        fail("VPS backups must be written to a different mounted storage device.");
    }

    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const finalDirectory = path.join(destinationRoot, `hausa-film-finder-${timestamp}`);
    if (fs.existsSync(finalDirectory)) fail("Timestamped backup already exists; refusing to overwrite it.");
    const stage = createStage(destinationRoot, "backup");
    try {
        const databaseRelative = "database/hausa-film-finder.sqlite";
        const databaseTarget = safeBundlePath(stage, databaseRelative);
        fs.mkdirSync(path.dirname(databaseTarget), { recursive: true, mode: 0o700 });
        sqliteBackup(inputs.database, databaseTarget);
        fs.chmodSync(databaseTarget, 0o600);
        verifyDatabase(databaseTarget);

        const mediaManifest = [];
        const copiedRoots = [];
        const files = [databaseRelative];
        for (const [name, source] of inputs.media) {
            const ancestor = copiedRoots.find((root) => inside(root.source, source));
            if (ancestor) {
                mediaManifest.push({ name, path: `media/${ancestor.name}/${path.relative(ancestor.source, source).split(path.sep).join("/")}` });
                continue;
            }
            const contained = copiedRoots.filter((root) => inside(source, root.source));
            if (contained.length) fail("Configured media directories overlap in an unsupported order.");
            const relativeRoot = `media/${name}`;
            copyTree(source, safeBundlePath(stage, relativeRoot), relativeRoot, files);
            copiedRoots.push({ name, source });
            mediaManifest.push({ name, path: relativeRoot });
        }

        const manifest = {
            format: "hausa-film-finder-backup",
            version: 1,
            created_at: new Date().toISOString(),
            database: databaseRelative,
            media_roots: mediaManifest,
            files: await buildFileManifest(stage, files)
        };
        const manifestPath = path.join(stage, MANIFEST_NAME);
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        await verifyManifestFiles(stage, manifest);
        fs.renameSync(stage, finalDirectory);
        console.log(`PASS: backup created (${manifest.files.length} files; SQLite and media hashes verified).`);
        console.log(`Backup folder: ${path.basename(finalDirectory)}`);
        return finalDirectory;
    } catch (error) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw error;
    }
}

async function restoreBackup(options) {
    const source = path.resolve(options.source || "");
    const target = path.resolve(options.target || "");
    if (!options.source || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) fail("Choose an existing backup folder.");
    if (!options.target || fs.existsSync(target)) fail("Restore target must be a new, unused directory.");
    if (inside(source, target) || inside(target, source)) fail("Restore target and backup folder must be separate directories.");
    const manifest = parseManifest(source);
    await verifyManifestFiles(source, manifest);
    if (!manifest.files.some((entry) => entry.path === manifest.database) || manifest.database !== "database/hausa-film-finder.sqlite") {
        fail("Backup manifest database entry is invalid.");
    }

    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stage = createStage(parent, "restore");
    try {
        for (const entry of manifest.files) {
            const from = safeBundlePath(source, entry.path);
            const to = safeBundlePath(stage, entry.path);
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(to, 0o600);
        }
        const restoredManifest = path.join(stage, MANIFEST_NAME);
        fs.copyFileSync(path.join(source, MANIFEST_NAME), restoredManifest, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(restoredManifest, 0o600);
        await verifyManifestFiles(stage, manifest);
        verifyDatabase(safeBundlePath(stage, manifest.database));
        fs.renameSync(stage, target);
        console.log(`PASS: restore created in a new directory (${manifest.files.length} files verified).`);
        console.log("PASS: restored SQLite integrity_check and foreign_key_check.");
        return target;
    } catch (error) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw error;
    }
}

async function main() {
    const [action, ...args] = process.argv.slice(2);
    if (action === "create" && fs.existsSync(path.join(projectRoot, ".env"))) {
        process.loadEnvFile(path.join(projectRoot, ".env"));
    }
    const options = parseOptions(args);
    if (action === "create") await createBackup(options);
    else if (action === "restore") await restoreBackup(options);
    else fail("Usage: node scripts/backup.js create --destination DIR [--database PATH] [media options], or restore --source DIR --target NEW_DIR.");
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Backup operation failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { createBackup, restoreBackup, verifyDatabase, verifyManifestFiles };
