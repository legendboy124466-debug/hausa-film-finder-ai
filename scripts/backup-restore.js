#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createReadStream, createWriteStream } = require("node:fs");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const sqlite = require("node:sqlite");

const MANIFEST_NAME = "manifest.json";
const DATABASE_NAME = "database.sqlite";
const MEDIA_NAME = "media";

function isWithin(childPath, parentPath) {
    const relative = path.relative(parentPath, childPath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function safeRelativePath(value) {
    if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)) return false;
    const pieces = value.split("/");
    return pieces.every((piece) => piece && piece !== "." && piece !== "..");
}

function listRegularFiles(rootDirectory) {
    const result = [];
    function visit(currentDirectory, relativeDirectory) {
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const absolute = path.join(currentDirectory, entry.name);
            const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
            if (/^\.env(?:\..*)?$|^cloud\.env(?:\..*)?$/i.test(entry.name)) {
                throw new Error("Media storage contains a file name reserved for private environment settings.");
            }
            const stats = fs.lstatSync(absolute);
            if (stats.isSymbolicLink()) throw new Error("Symbolic links are not allowed in media storage.");
            if (stats.isDirectory()) {
                visit(absolute, relative);
            } else if (stats.isFile()) {
                result.push({ absolute, relative, size: stats.size, mtimeMs: stats.mtimeMs });
            } else {
                throw new Error("Media storage contains an unsupported filesystem entry.");
            }
        }
    }
    visit(rootDirectory, "");
    return result.sort((a, b) => a.relative.localeCompare(b.relative));
}

function digestFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const input = createReadStream(filePath);
        input.on("error", reject);
        input.on("data", (chunk) => hash.update(chunk));
        input.on("end", () => resolve(hash.digest("hex")));
    });
}

function assertDatabaseIntegrity(databasePath) {
    const database = new sqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 5000 });
    try {
        const integrityRows = database.prepare("PRAGMA integrity_check").all();
        const integrityValues = integrityRows.map((row) => Object.values(row)[0]);
        if (integrityValues.length !== 1 || integrityValues[0] !== "ok") {
            throw new Error("SQLite integrity_check did not pass.");
        }
        const foreignKeyRows = database.prepare("PRAGMA foreign_key_check").all();
        if (foreignKeyRows.length) throw new Error("SQLite foreign_key_check found violations.");
        return { integrityCheck: "ok", foreignKeyCheck: "ok" };
    } finally {
        database.close();
    }
}

async function copyAndVerify(source, target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const hash = crypto.createHash("sha256");
    const tap = new Transform({
        transform(chunk, encoding, callback) {
            hash.update(chunk);
            callback(null, chunk);
        }
    });
    await pipeline(createReadStream(source), tap, createWriteStream(target, { flags: "wx" }));
    const sourceHash = hash.digest("hex");
    const targetHash = await digestFile(target);
    if (sourceHash !== targetHash) throw new Error("A copied file failed SHA-256 verification.");
    return { sha256: targetHash, size: fs.statSync(target).size };
}

function createBackupDirectory(destinationRoot) {
    fs.mkdirSync(destinationRoot, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    for (let attempt = 0; attempt < 10; attempt += 1) {
        const suffix = crypto.randomBytes(3).toString("hex");
        const candidate = path.join(destinationRoot, `hausa-film-finder-${timestamp}-${suffix}`);
        try {
            fs.mkdirSync(candidate, { recursive: false });
            return candidate;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    }
    throw new Error("Could not allocate a unique backup folder.");
}

async function backupProject({ databasePath, mediaPath, destination, mediaQuiesced }) {
    if (typeof sqlite.backup !== "function") {
        throw new Error("This script requires Node.js 22.16.0 or later for the SQLite Online Backup API.");
    }
    if (!mediaQuiesced) throw new Error("Pause media uploads, replacements, deletions, and playback conversions; then pass --media-quiesced.");
    const sourceDatabase = fs.realpathSync(databasePath);
    const sourceMedia = fs.realpathSync(mediaPath);
    const destinationRoot = path.resolve(destination);
    if (!fs.statSync(sourceDatabase).isFile() || !fs.statSync(sourceMedia).isDirectory()) {
        throw new Error("Database or media source is not the expected file/directory.");
    }
    if (isWithin(destinationRoot, sourceMedia)) {
        throw new Error("Backup destination must be outside persistent media storage.");
    }

    const initialInventory = listRegularFiles(sourceMedia);
    const backupDirectory = createBackupDirectory(destinationRoot);
    const incompleteMarker = path.join(backupDirectory, "INCOMPLETE.txt");
    fs.writeFileSync(incompleteMarker, "Backup did not complete. Do not restore this folder.\n", { flag: "wx" });

    const databaseTarget = path.join(backupDirectory, DATABASE_NAME);
    const source = new sqlite.DatabaseSync(sourceDatabase, { readOnly: true, timeout: 5000 });
    try {
        await sqlite.backup(source, databaseTarget);
    } finally {
        source.close();
    }
    const databaseChecks = assertDatabaseIntegrity(databaseTarget);
    const databaseDigest = await digestFile(databaseTarget);
    const databaseSize = fs.statSync(databaseTarget).size;

    const mediaEntries = [];
    for (const entry of initialInventory) {
        const target = path.join(backupDirectory, MEDIA_NAME, ...entry.relative.split("/"));
        const copied = await copyAndVerify(entry.absolute, target);
        mediaEntries.push({ path: entry.relative, size: copied.size, sha256: copied.sha256 });
    }

    const finalInventory = listRegularFiles(sourceMedia);
    const sourceChanged = initialInventory.length !== finalInventory.length ||
        initialInventory.some((entry, index) => {
            const current = finalInventory[index];
            return !current || entry.relative !== current.relative || entry.size !== current.size ||
                entry.mtimeMs !== current.mtimeMs;
        });
    if (sourceChanged) throw new Error("Media storage changed during backup; the incomplete folder was preserved.");

    const manifest = {
        formatVersion: 1,
        createdAt: new Date().toISOString(),
        database: { file: DATABASE_NAME, size: databaseSize, sha256: databaseDigest },
        media: {
            directory: MEDIA_NAME,
            fileCount: mediaEntries.length,
            totalBytes: mediaEntries.reduce((total, entry) => total + entry.size, 0),
            files: mediaEntries
        },
        databaseChecks
    };
    const temporaryManifest = path.join(backupDirectory, `${MANIFEST_NAME}.tmp`);
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporaryManifest, path.join(backupDirectory, MANIFEST_NAME));
    fs.rmSync(incompleteMarker);
    return { backupDirectory, manifest };
}

function readManifest(backupDirectory) {
    const root = fs.realpathSync(backupDirectory);
    if (fs.existsSync(path.join(root, "INCOMPLETE.txt"))) {
        throw new Error("This backup is marked incomplete.");
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_NAME), "utf8"));
    if (manifest.formatVersion !== 1 || manifest.database?.file !== DATABASE_NAME ||
        manifest.media?.directory !== MEDIA_NAME || !Array.isArray(manifest.media.files)) {
        throw new Error("Backup manifest format is invalid.");
    }
    return { root, manifest };
}

async function verifyBackup(backupDirectory) {
    const { root, manifest } = readManifest(backupDirectory);
    const dbPath = path.join(root, DATABASE_NAME);
    if (fs.lstatSync(dbPath).isSymbolicLink() || fs.statSync(dbPath).size !== manifest.database.size ||
        await digestFile(dbPath) !== manifest.database.sha256) {
        throw new Error("Database backup SHA-256 verification failed.");
    }
    const seen = new Set();
    let totalBytes = 0;
    for (const entry of manifest.media.files) {
        if (!safeRelativePath(entry.path) || seen.has(entry.path) ||
            !Number.isSafeInteger(entry.size) || typeof entry.sha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            throw new Error("Media manifest entry is invalid.");
        }
        seen.add(entry.path);
        const filePath = path.resolve(root, MEDIA_NAME, ...entry.path.split("/"));
        if (!isWithin(filePath, path.join(root, MEDIA_NAME)) || fs.lstatSync(filePath).isSymbolicLink() ||
            fs.statSync(filePath).size !== entry.size || await digestFile(filePath) !== entry.sha256) {
            throw new Error("A media file failed SHA-256 verification.");
        }
        totalBytes += entry.size;
    }
    const actualMedia = listRegularFiles(path.join(root, MEDIA_NAME));
    if (actualMedia.length !== seen.size || manifest.media.fileCount !== seen.size ||
        manifest.media.totalBytes !== totalBytes || actualMedia.some((file) => !seen.has(file.relative))) {
        throw new Error("Media backup contents do not match the manifest.");
    }
    const databaseChecks = assertDatabaseIntegrity(dbPath);
    return { backupDirectory: root, manifest, databaseChecks };
}

async function restoreBackup({ backupDirectory, destination }) {
    const verified = await verifyBackup(backupDirectory);
    const targetRoot = path.resolve(destination);
    if (fs.existsSync(targetRoot)) throw new Error("Restore destination already exists; choose a new empty directory.");
    if (isWithin(targetRoot, verified.backupDirectory) || isWithin(verified.backupDirectory, targetRoot)) {
        throw new Error("Restore destination must be separate from the backup folder.");
    }
    fs.mkdirSync(targetRoot, { recursive: false });
    const dbPath = path.join(targetRoot, DATABASE_NAME);
    const dbCopied = await copyAndVerify(path.join(verified.backupDirectory, DATABASE_NAME), dbPath);
    if (dbCopied.sha256 !== verified.manifest.database.sha256) throw new Error("Restored database hash differs from backup.");
    for (const entry of verified.manifest.media.files) {
        const source = path.join(verified.backupDirectory, MEDIA_NAME, ...entry.path.split("/"));
        const target = path.join(targetRoot, MEDIA_NAME, ...entry.path.split("/"));
        const copied = await copyAndVerify(source, target);
        if (copied.sha256 !== entry.sha256) throw new Error("Restored media hash differs from backup.");
    }
    const databaseChecks = assertDatabaseIntegrity(dbPath);
    return { restoreDirectory: targetRoot, databaseChecks, fileCount: verified.manifest.media.fileCount };
}

function parseFlags(args) {
    const flags = new Map();
    for (let index = 0; index < args.length; index += 1) {
        const name = args[index];
        if (!name.startsWith("--")) throw new Error("Use named options such as --database.");
        if (name === "--media-quiesced") {
            flags.set(name, true);
            continue;
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Option ${name} needs a value.`);
        flags.set(name, value);
        index += 1;
    }
    return flags;
}

function printUsage() {
    process.stdout.write([
        "Backup:  node scripts/backup-restore.js backup --database <sqlite-file> --media <media-dir> --destination <backup-root> --media-quiesced",
        "Verify:  node scripts/backup-restore.js verify --backup <backup-folder>",
        "Restore: node scripts/backup-restore.js restore --backup <backup-folder> --destination <new-test-dir>",
        "Check:   node scripts/backup-restore.js check --database <sqlite-file>",
        "The backup command uses SQLite Online Backup API. The media write freeze is required for a consistent media snapshot."
    ].join("\n") + "\n");
}

async function runCli(args) {
    const [command, ...optionArgs] = args;
    if (!command || command === "--help" || command === "help") return printUsage();
    const flags = parseFlags(optionArgs);
    if (command === "backup") {
        const result = await backupProject({
            databasePath: flags.get("--database"),
            mediaPath: flags.get("--media"),
            destination: flags.get("--destination"),
            mediaQuiesced: flags.has("--media-quiesced")
        });
        process.stdout.write(`Backup completed: ${result.backupDirectory}\n`);
        process.stdout.write(`Media files: ${result.manifest.media.fileCount}; SQLite integrity and foreign keys: ok\n`);
        return;
    }
    if (command === "verify") {
        const result = await verifyBackup(flags.get("--backup"));
        process.stdout.write(`Backup verified: ${result.manifest.media.fileCount} media files; SQLite integrity and foreign keys: ok\n`);
        return;
    }
    if (command === "restore") {
        const result = await restoreBackup({ backupDirectory: flags.get("--backup"), destination: flags.get("--destination") });
        process.stdout.write(`Restore verified in new directory: ${result.restoreDirectory}\n`);
        process.stdout.write(`Media files: ${result.fileCount}; SQLite integrity and foreign keys: ok\n`);
        return;
    }
    if (command === "check") {
        assertDatabaseIntegrity(flags.get("--database"));
        process.stdout.write("SQLite integrity_check: ok; foreign_key_check: ok\n");
        return;
    }
    throw new Error("Unknown command. Use --help for instructions.");
}

if (require.main === module) {
    runCli(process.argv.slice(2)).catch(() => {
        process.stderr.write("Backup/restore failed. No existing backup was deleted; inspect paths and permissions locally.\n");
        process.exitCode = 1;
    });
}

module.exports = { backupProject, verifyBackup, restoreBackup, assertDatabaseIntegrity };
