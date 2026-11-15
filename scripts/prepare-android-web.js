const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const webRoot = path.join(root, "www");
const fileMap = [
    ["index.html", "index.html"],
    ["style.css", "style.css"],
    ["app.js", "app.js"],
    ["social.js", "social.js"],
    ["server-config.js", "server-config.js"],
    ["manifest.webmanifest", "manifest.webmanifest"],
    ["merlin-poster.html", "merlin-poster.html"],
    ["assets/app-icon-192.png", "assets/app-icon-192.png"],
    ["assets/app-icon-512.png", "assets/app-icon-512.png"],
    ["assets/apple-touch-icon.png", "assets/apple-touch-icon.png"],
    ["assets/hausa-film-finder-promotional-poster.png", "assets/hausa-film-finder-promotional-poster.png"],
    ["admin/admin.html", "admin/admin.html"],
    ["admin/admin.css", "admin/admin.css"],
    ["admin/admin.js", "admin/admin.js"]
];

for (const [source, destination] of fileMap) {
    const sourcePath = path.join(root, source);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        throw new Error(`Android web asset is missing: ${source}`);
    }
}

for (const [source, destination] of fileMap) {
    const destinationPath = path.join(webRoot, destination);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(path.join(root, source), destinationPath);
}

const resourcesRoot = path.join(root, "resources");
fs.mkdirSync(resourcesRoot, { recursive: true });
fs.copyFileSync(path.join(root, "assets", "app-icon-512.png"), path.join(resourcesRoot, "icon.png"));
fs.copyFileSync(
    path.join(root, "assets", "hausa-film-finder-promotional-poster.png"),
    path.join(resourcesRoot, "splash.png")
);

console.log(`Prepared ${fileMap.length} web assets in www. No database or uploaded media is included.`);
