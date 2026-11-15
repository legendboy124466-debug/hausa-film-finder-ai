const loginPanel = document.getElementById("loginPanel");
const dashboardPanel = document.getElementById("dashboardPanel");
const loginMessage = document.getElementById("loginMessage");
const formMessage = document.getElementById("formMessage");
const movieBulkForm = document.getElementById("movieBulkForm");
const movieBulkFiles = document.getElementById("movieBulkFiles");
const movieBulkProgress = document.getElementById("movieBulkProgress");
const movieBulkStatus = document.getElementById("movieBulkStatus");
const movieBulkUploadButton = document.getElementById("movieBulkUploadButton");
const studioMessage = document.getElementById("studioMessage");
const jobsList = document.getElementById("jobsList");
const adminMoviesList = document.getElementById("adminMoviesList");
const socialReportsList = document.getElementById("socialReportsList");
const socialUsersList = document.getElementById("socialUsersList");
const ownerAgentStatus = document.getElementById("ownerAgentStatus");
const ownerAgentSummary = document.getElementById("ownerAgentSummary");
const ownerAgentResult = document.getElementById("ownerAgentResult");
const ownerAgentHistory = document.getElementById("ownerAgentHistory");
const merlinSlots = document.getElementById("merlinSlots");
const merlinBulkForm = document.getElementById("merlinBulkForm");
const merlinBulkFiles = document.getElementById("merlinBulkFiles");
const merlinBulkButton = document.getElementById("merlinBulkButton");
const merlinBulkProgress = document.getElementById("merlinBulkProgress");
const merlinBulkStatus = document.getElementById("merlinBulkStatus");
const merlinMovieBulkForm = document.getElementById("merlinMovieBulkForm");
const merlinMovieFiles = document.getElementById("merlinMovieFiles");
const merlinMovieQueue = document.getElementById("merlinMovieQueue");
const merlinMovieUploadProgress = document.getElementById("merlinMovieUploadProgress");
const merlinMovieBulkStatus = document.getElementById("merlinMovieBulkStatus");
const merlinMovieUploadButton = document.getElementById("merlinMovieUploadButton");
const selectedMerlinMovieNames = document.getElementById("selectedMerlinMovieNames");
let merlinEpisodes = [];
let merlinMovieQueueEntries = [];

const nativeAdminSessionPlugin = window.Capacitor?.isNativePlatform?.() &&
    typeof window.Capacitor.registerPlugin === "function"
    ? window.Capacitor.registerPlugin("AdminSession")
    : null;
let nativeAdminToken = null;
let nativeAdminTokenLoaded = false;

async function loadNativeAdminToken() {
    if (!nativeAdminSessionPlugin) return null;
    if (nativeAdminTokenLoaded) return nativeAdminToken;
    const stored = await nativeAdminSessionPlugin.getToken();
    nativeAdminToken = typeof stored?.token === "string" && stored.expiresAt > Date.now()
        ? stored.token
        : null;
    nativeAdminTokenLoaded = true;
    return nativeAdminToken;
}

async function clearNativeAdminToken() {
    nativeAdminToken = null;
    nativeAdminTokenLoaded = true;
    if (nativeAdminSessionPlugin) await nativeAdminSessionPlugin.clearToken();
}

async function adminRequest(url, options = {}) {
    const isNativeLogin = Boolean(nativeAdminSessionPlugin) && url === "/api/admin/login";
    const headers = new Headers(options.headers || {});
    if (nativeAdminSessionPlugin && !isNativeLogin) {
        const token = await loadNativeAdminToken();
        if (token) headers.set(`Authorization`, `Bearer ${token}`);
    }
    const response = await fetch(window.hfApiUrl(url), {
        ...options,
        credentials: nativeAdminSessionPlugin ? "omit" : "include",
        headers
    });
    const payload = await response.json().catch(() => ({}));
    if (nativeAdminSessionPlugin && isNativeLogin && response.ok) {
        if (typeof payload.accessToken !== "string" || !Number.isFinite(payload.expiresAt)) {
            throw new Error("Backend bai bayar da Admin session token mai inganci ba.");
        }
        try {
            await nativeAdminSessionPlugin.setToken({
                token: payload.accessToken,
                expiresAt: payload.expiresAt
            });
            nativeAdminToken = payload.accessToken;
            nativeAdminTokenLoaded = true;
        } catch {
            const revokeHeaders = new Headers({ Authorization: `Bearer ${payload.accessToken}` });
            await fetch(window.hfApiUrl("/api/admin/logout"), {
                method: "POST",
                credentials: "omit",
                headers: revokeHeaders
            }).catch(() => {});
            throw new Error("Ba a iya adana Admin session cikin tsaro a wayar ba. Ka sake gwadawa.");
        }
        delete payload.accessToken;
    }
    if (nativeAdminSessionPlugin && response.status === 401) {
        await clearNativeAdminToken();
    }
    if (nativeAdminSessionPlugin && url === "/api/admin/logout") {
        await clearNativeAdminToken();
    }
    if (!response.ok) throw new Error(payload.error || `Buƙatar ta gaza (${response.status}).`);
    return payload;
}

function showMessage(element, text, isError = false) {
    element.textContent = text;
    element.className = `message${text ? (isError ? " error" : " success") : ""}`;
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return "Ba a tantance ba";
    const total = Math.floor(seconds);
    return `${Math.floor(total / 3600)}:${String(Math.floor(total % 3600 / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function displayDuration(seconds) {
    if (!Number.isFinite(seconds)) return "Ana tantance tsawon lokaci…";
    const minutes = Math.floor(seconds / 60);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusName(status) {
    return {
        waiting: "Pending · Ana jira",
        processing: "Processing · Ana sarrafawa",
        completed: "Completed · An kammala",
        failed: "Failed · An kasa",
        paused: "Paused · An dakatar"
    }[status] || status;
}

async function loadStudios() {
    const data = await adminRequest("/api/admin/studios");
    const select = document.getElementById("studio");
    const previous = select.value;
    select.replaceChildren(new Option("Zaɓi studio", ""));
    for (const studio of data.studios) {
        const option = new Option(`${studio.name} · ${studio.permission_status}`, studio.name);
        select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function appendJobAction(container, label, action, jobId, className = "secondary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", async () => {
        button.disabled = true;
        try {
            await adminRequest(`/api/admin/jobs/${encodeURIComponent(jobId)}/${action}`, {
                method: "POST"
            });
            await loadJobs();
        } catch (error) {
            alert(error.message);
        } finally {
            button.disabled = false;
        }
    });
    container.appendChild(button);
}

async function showSegments(jobId, container) {
    const output = document.createElement("div");
    output.className = "segments-list";
    output.textContent = "Ana ɗauko segments…";
    container.appendChild(output);
    try {
        const data = await adminRequest(`/api/admin/jobs/${encodeURIComponent(jobId)}/segments`);
        output.replaceChildren();
        if (!data.segments.length) {
            output.textContent = "Har yanzu ba a ƙirƙiri jerin segments ba.";
            return;
        }
        for (const segment of data.segments) {
            const line = document.createElement("p");
            line.textContent = `Segment ${segment.segmentNumber}: ${formatTime(segment.startSeconds)}–${formatTime(segment.endSeconds)} · ${statusName(segment.status)}${segment.error ? ` · ${segment.error}` : ""}`;
            output.appendChild(line);
        }
    } catch (error) {
        output.textContent = `An kasa ɗauko segments: ${error.message}`;
    }
}

function movieEditField(labelText, name, value, options = {}) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = options.multiline ? document.createElement("textarea") : document.createElement("input");
    input.name = name;
    input.value = value ?? "";
    if (options.multiline) input.rows = options.rows || 3;
    else input.type = options.type || "text";
    if (options.maxLength) input.maxLength = options.maxLength;
    if (options.min !== undefined) input.min = options.min;
    if (options.max !== undefined) input.max = options.max;
    if (options.required) input.required = true;
    label.appendChild(input);
    return label;
}

function createMovieEditPanel(movie) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Gyara bayanan fim";
    const form = document.createElement("form");
    form.className = "form-grid movie-edit-form";
    const episodeList = Array.isArray(movie.episodes) ? movie.episodes : [];
    form.append(
        movieEditField("Taken fim", "title", movie.originalTitle, { required: true, maxLength: 200 }),
        movieEditField("Sunan Hausa", "hausaTitle", movie.hausaTitle, { maxLength: 200 }),
        movieEditField("Harshe", "language", movie.language, { maxLength: 100 }),
        movieEditField("Jarumai (raba da waƙafi)", "actors", (movie.actors || []).join(", "), { maxLength: 1200 }),
        movieEditField("Dubbing studio", "studio", movie.studio, { required: true, maxLength: 200 }),
        movieEditField("Shekara", "year", movie.year, { type: "number", min: 1888, max: 2100 }),
        movieEditField("Ƙasar asali", "country", movie.country, { maxLength: 100 }),
        movieEditField("Rukuni (raba da waƙafi)", "categories", (movie.categories || []).join(", "), { maxLength: 300 }),
        movieEditField("Season:Episode (misali 1:1, 1:2)", "episodes",
            episodeList.map((entry) => `${entry.seasonNumber}:${entry.episodeNumber}`).join(", "), { maxLength: 300 }),
        movieEditField("Bayani", "description", movie.description, { multiline: true, maxLength: 5000, rows: 4 })
    );
    const actions = document.createElement("div");
    actions.className = "job-actions wide-field";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Ajiye canje-canje";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-merlin-video";
    remove.textContent = "Share fim da fayilolinsa";
    actions.append(save, remove);
    const feedback = document.createElement("p");
    feedback.className = "message wide-field";
    feedback.setAttribute("role", "status");
    form.append(actions, feedback);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        save.disabled = true;
        const values = new FormData(form);
        const episodesText = String(values.get("episodes") || "").trim();
        const episodes = episodesText ? episodesText.split(",").map((item) => {
            const match = item.trim().match(/^(\d+)\s*:\s*(\d+)$/);
            return match ? { seasonNumber: Number(match[1]), episodeNumber: Number(match[2]) } : null;
        }) : [];
        if (episodes.some((episode) => !episode)) {
            showMessage(feedback, "Rubuta season da episode kamar 1:1, 1:2.", true);
            save.disabled = false;
            return;
        }
        try {
            await adminRequest(`/api/admin/movies/${encodeURIComponent(movie.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: values.get("title"), hausaTitle: values.get("hausaTitle"),
                    language: values.get("language"),
                    actors: String(values.get("actors") || "").split(",").map((item) => item.trim()).filter(Boolean),
                    studio: values.get("studio"), year: values.get("year"),
                    country: values.get("country"), description: values.get("description"),
                    categories: String(values.get("categories") || "").split(",").map((item) => item.trim()).filter(Boolean),
                    episodes
                })
            });
            await loadAdminMovies();
        } catch (error) {
            showMessage(feedback, error.message, true);
            save.disabled = false;
        }
    });
    remove.addEventListener("click", async () => {
        if (!window.confirm(`A share ${movie.originalTitle} da fayil ɗin bidiyo da poster da ke da alaƙa? Wannan ba za a iya warwarewa ba.`)) return;
        remove.disabled = true;
        try {
            await adminRequest(`/api/admin/movies/${encodeURIComponent(movie.id)}`, { method: "DELETE" });
            await Promise.all([loadAdminMovies(), loadJobs()]);
        } catch (error) {
            showMessage(feedback, error.message, true);
            remove.disabled = false;
        }
    });
    details.append(summary, form);
    return details;
}

async function loadJobs() {
    try {
        const data = await adminRequest("/api/admin/jobs");
        jobsList.replaceChildren();
        if (!data.jobs.length) {
            jobsList.textContent = "Babu aikin sarrafawa tukuna.";
            return;
        }
        for (const job of data.jobs) {
            const card = document.createElement("article");
            card.className = "job-card";
            const heading = document.createElement("h3");
            heading.textContent = job.title;
            if (Number.isInteger(job.episode_number)) {
                heading.textContent += ` · Episode ${String(job.episode_number).padStart(2, "0")}`;
            }
            const meta = document.createElement("p");
            meta.className = "job-meta";
            meta.textContent = `Matsayi: ${statusName(job.status)} · Tsawon fim: ${displayDuration(job.duration_seconds)} · Segments: ${job.completed_segments}/${job.total_segments} · An kasa: ${job.failed_segments}`;
            card.append(heading, meta);
            const progressPercent = job.total_segments
                ? Math.floor((job.completed_segments / job.total_segments) * 100)
                : 0;
            meta.textContent = `Upload: ${job.upload_status === "completed" ? "Completed" : "Failed"} · Fingerprint: ${statusName(job.status)} · Segments: ${job.completed_segments}/${job.total_segments} · Failed: ${job.failed_segments} · ${progressPercent}% · Stage: ${job.processing_stage || job.status}`;
            if (job.total_segments > 0) {
                const progress = document.createElement("progress");
                progress.max = job.total_segments;
                progress.value = job.completed_segments;
                progress.setAttribute("aria-label", `Ci gaban ${job.title}`);
                card.appendChild(progress);
            }
            if (job.error) {
                const error = document.createElement("p");
                error.className = "message error";
                error.textContent = job.error;
                card.appendChild(error);
            }
            const actions = document.createElement("div");
            actions.className = "job-actions";
            if (job.status === "waiting" || job.status === "processing") {
                appendJobAction(actions, "Dakatar", "pause", job.id);
            }
            if (job.status === "paused" || job.status === "failed") {
                appendJobAction(actions, job.failed_segments ? "Sake gwada waɗanda suka kasa" : "Ci gaba", "resume", job.id);
            }
            const segmentsButton = document.createElement("button");
            segmentsButton.type = "button";
            segmentsButton.className = "secondary";
            segmentsButton.textContent = "Duba segments";
            segmentsButton.addEventListener("click", () => showSegments(job.id, card));
            actions.appendChild(segmentsButton);
            card.appendChild(actions);
            jobsList.appendChild(card);
        }
    } catch (error) {
        jobsList.textContent = `An kasa ɗauko aikin sarrafawa: ${error.message}`;
    }
}

async function loadAdminMovies() {
    try {
        const data = await adminRequest("/api/admin/movies");
        adminMoviesList.replaceChildren();
        if (!data.movies.length) {
            adminMoviesList.textContent = "Babu fim a database tukuna.";
            return;
        }
        for (const movie of data.movies) {
            const card = document.createElement("article");
            card.className = "job-card";
            const title = document.createElement("h3");
            title.textContent = `${movie.hausaTitle ? `${movie.hausaTitle} · ` : ""}${movie.originalTitle}`;
            const state = document.createElement("p");
            state.className = "job-meta";
            state.textContent = `Studio: ${movie.studio} · Izinin amfani: ${movie.permissionConfirmed ? "An tabbatar" : "Ba a tabbatar ba"} · Fingerprint: ${movie.fingerprintStatus || "Ba a sarrafa tushen fim ba"}`;
            card.append(title, state);
            if (movie.posterUrl) {
                const poster = document.createElement("img");
                poster.src = window.hfApiUrl(movie.posterUrl);
                poster.alt = `Poster: ${movie.originalTitle}`;
                poster.loading = "lazy";
                poster.style.maxWidth = "12rem";
                card.appendChild(poster);
            }
            if (movie.hasVideo && movie.permissionConfirmed) {
                const preview = document.createElement("video");
                preview.controls = true;
                preview.preload = "metadata";
                preview.playsInline = true;
                preview.src = window.hfApiUrl(`/api/movies/${encodeURIComponent(movie.id)}/video`);
                preview.setAttribute("aria-label", `Bidiyon ${movie.originalTitle}`);
                preview.style.maxWidth = "100%";
                preview.style.maxHeight = "24rem";
                card.appendChild(preview);
            }
            if (!movie.permissionConfirmed) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = "Tabbatar da izinin wannan fim";
                button.addEventListener("click", async () => {
                    if (!window.confirm("Ka tabbatar cewa kai ko masu haƙƙi sun ba da izinin nuna wannan bayanin da poster?")) return;
                    button.disabled = true;
                    try {
                        await adminRequest(`/api/admin/movies/${encodeURIComponent(movie.id)}/permission`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ permissionConfirmed: true })
                        });
                        await loadAdminMovies();
                    } catch (error) {
                        showMessage(formMessage, error.message, true);
                        button.disabled = false;
                    }
                });
                card.appendChild(button);
            }
            card.appendChild(createMovieEditPanel(movie));
            adminMoviesList.appendChild(card);
        }
    } catch (error) {
        adminMoviesList.textContent = `An kasa ɗauko bayanan fim: ${error.message}`;
    }
}

function uploadGenericMovie(file, metadata, onProgress) {
    const formData = new FormData();
    formData.append("movie", file, file.name);
    formData.append("title", file.name.replace(/\.[^.]+$/, "").trim());
    formData.append("studio", metadata.studio);
    formData.append("language", metadata.language);
    formData.append("year", metadata.year);
    formData.append("country", metadata.country);
    formData.append("actors", metadata.actors);
    formData.append("permissionConfirmed", "true");
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", window.hfApiUrl("/api/admin/movies"));
        request.withCredentials = true;
        request.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) onProgress(event.loaded / event.total);
        });
        request.addEventListener("load", () => {
            let payload;
            try {
                payload = request.responseText ? JSON.parse(request.responseText) : {};
            } catch {
                reject(new Error("Amsa daga server ba ta inganta ba."));
                return;
            }
            if (request.status < 200 || request.status >= 300) {
                reject(new Error(payload.error || `Upload ya gaza (${request.status}).`));
                return;
            }
            resolve(payload);
        });
        request.addEventListener("error", () => reject(new Error("Haɗin server ya katse yayin upload.")));
        request.addEventListener("abort", () => reject(new Error("An soke upload.")));
        request.send(formData);
    });
}

movieBulkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = [...movieBulkFiles.files];
    const permission = document.getElementById("movieBulkPermission");
    if (!files.length || !permission.checked) {
        showMessage(movieBulkStatus, "Zaɓi bidiyoyi kuma tabbatar da izinin amfani kafin upload.", true);
        return;
    }
    movieBulkUploadButton.disabled = true;
    movieBulkProgress.hidden = false;
    movieBulkProgress.value = 0;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let completedBytes = 0;
    const failures = [];
    const metadata = {
        studio: document.getElementById("movieBulkStudio").value.trim(),
        language: document.getElementById("movieBulkLanguage").value.trim(),
        year: document.getElementById("movieBulkYear").value,
        country: document.getElementById("movieBulkCountry").value.trim(),
        actors: document.getElementById("movieBulkActors").value.trim()
    };
    for (const [index, file] of files.entries()) {
        showMessage(movieBulkStatus, `Ana loda ${index + 1}/${files.length}: ${file.name}`);
        try {
            await uploadGenericMovie(file, metadata, (fraction) => {
                movieBulkProgress.value = totalBytes
                    ? ((completedBytes + fraction * file.size) / totalBytes) * 100
                    : ((index + fraction) / files.length) * 100;
            });
        } catch (error) {
            failures.push(`${file.name}: ${error.message}`);
        }
        completedBytes += file.size;
        movieBulkProgress.value = totalBytes ? (completedBytes / totalBytes) * 100 : ((index + 1) / files.length) * 100;
    }
    movieBulkFiles.value = "";
    await Promise.all([loadAdminMovies(), loadJobs()]);
    showMessage(movieBulkStatus,
        failures.length
            ? `An kammala ${files.length - failures.length}/${files.length}; an samu kuskure: ${failures.join(" · ")}`
            : `An loda bidiyo ${files.length}. Ana sarrafa fingerprints a baya.`,
        failures.length > 0);
    movieBulkUploadButton.disabled = false;
});

function merlinFormData(episode, videoFile = null) {
    const formData = new FormData();
    formData.append("title", episode.title);
    formData.append("description", episode.description);
    if (videoFile) formData.append("video", videoFile);
    return formData;
}

function uploadMerlinFile(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("PUT", url);
        request.withCredentials = true;
        request.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) onProgress(event.loaded / event.total);
        });
        request.addEventListener("load", () => {
            let payload;
            try {
                payload = request.responseText ? JSON.parse(request.responseText) : {};
            } catch {
                reject(new Error("Amsa daga server ba ta inganta ba."));
                return;
            }
            if (request.status < 200 || request.status >= 300) {
                reject(new Error(payload.error || `Lodawa ta gaza (${request.status}).`));
                return;
            }
            resolve(payload);
        });
        request.addEventListener("error", () => reject(new Error("An kasa haɗuwa da server yayin lodawa.")));
        request.send(formData);
    });
}

function uploadMerlinEpisode(episodeNumber, formData, onProgress) {
    return uploadMerlinFile(`/api/admin/merlin/${episodeNumber}`, formData, onProgress);
}

function uploadMerlinPoster(episodeNumber, posterFile, onProgress) {
    const formData = new FormData();
    formData.append("poster", posterFile);
    return uploadMerlinFile(`/api/admin/merlin/${episodeNumber}/poster`, formData, onProgress);
}

function createMerlinSlotCard(episode) {
    const card = document.createElement("article");
    card.className = "merlin-slot-card";
    const heading = document.createElement("div");
    heading.className = "merlin-slot-heading";
    const title = document.createElement("h3");
    title.textContent = `Merlin ${String(episode.episodeNumber).padStart(2, "0")}`;
    const state = document.createElement("p");
    state.textContent = episode.hasVideo ? "Bidiyo ya cika" : "Slot ɗin babu bidiyo";
    heading.append(title, state);
    card.appendChild(heading);

    if (episode.posterUrl) {
        const poster = document.createElement("img");
        poster.className = "merlin-slot-poster";
        poster.src = window.hfApiUrl(episode.posterUrl);
        poster.alt = `Poster: ${episode.title}`;
        card.appendChild(poster);
    } else {
        const posterPlaceholder = document.createElement("div");
        posterPlaceholder.className = "merlin-slot-poster merlin-slot-poster-empty";
        posterPlaceholder.textContent = "Babu poster tukuna";
        card.appendChild(posterPlaceholder);
    }
    const posterSource = document.createElement("p");
    posterSource.className = "merlin-poster-source";
    posterSource.textContent = episode.posterSource === "episode"
        ? "Poster na musamman na wannan episode"
        : episode.posterSource === "shared"
            ? "Ana amfani da shared poster na Season 1"
            : "Babu poster tukuna";
    card.appendChild(posterSource);

    if (episode.hasVideo) {
        const preview = document.createElement("video");
        preview.className = "merlin-slot-preview";
        preview.controls = true;
        preview.preload = "metadata";
        preview.playsInline = true;
        preview.src = episode.videoUrl;
        if (episode.posterUrl) preview.poster = episode.posterUrl;
        preview.setAttribute("aria-label", `Bidiyon ${episode.title}`);
        card.appendChild(preview);
    }

    const form = document.createElement("form");
    form.className = "merlin-slot-form";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = "Taken episode";
    const titleInput = document.createElement("input");
    titleInput.name = "title";
    titleInput.maxLength = 200;
    titleInput.required = true;
    titleInput.value = episode.title;
    titleLabel.appendChild(titleInput);
    const descriptionLabel = document.createElement("label");
    descriptionLabel.textContent = "Bayani";
    const descriptionInput = document.createElement("textarea");
    descriptionInput.name = "description";
    descriptionInput.maxLength = 5000;
    descriptionInput.rows = 3;
    descriptionInput.value = episode.description;
    descriptionLabel.appendChild(descriptionInput);
    const videoLabel = document.createElement("label");
    videoLabel.textContent = episode.hasVideo ? "Sauya bidiyo" : "Zaɓi bidiyo";
    const videoInput = document.createElement("input");
    videoInput.name = "video";
    videoInput.type = "file";
    videoInput.accept = "video/*,.mkv,.mp4,.mov,.webm";
    videoLabel.appendChild(videoInput);
    const posterLabel = document.createElement("label");
    posterLabel.textContent = episode.episodePosterUrl
        ? "Sauya poster na wannan episode"
        : "Loda poster na musamman (zai maye gurbin shared poster)";
    const posterInput = document.createElement("input");
    posterInput.name = "poster";
    posterInput.type = "file";
    posterInput.accept = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";
    posterLabel.appendChild(posterInput);
    const saveButton = document.createElement("button");
    saveButton.type = "submit";
    saveButton.textContent = "Ajiye bayanai / loda fayil";
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = 0;
    progress.hidden = true;
    const status = document.createElement("p");
    status.className = "message";
    status.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "job-actions";
    actions.appendChild(saveButton);
    if (episode.hasVideo) {
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "delete-merlin-video";
        deleteButton.textContent = "Cire bidiyon";
        deleteButton.addEventListener("click", async () => {
            if (!window.confirm(`Ka tabbatar kana son cire bidiyon ${episode.title}?`)) return;
            deleteButton.disabled = true;
            try {
                await adminRequest(`/api/admin/merlin/${episode.episodeNumber}/video`, {
                    method: "DELETE"
                });
                await loadMerlinEpisodes(true);
            } catch (error) {
                showMessage(status, error.message, true);
                deleteButton.disabled = false;
            }
        });
        actions.appendChild(deleteButton);
    }
    form.append(
        titleLabel, descriptionLabel, videoLabel, posterLabel,
        actions, progress, status
    );
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        saveButton.disabled = true;
        progress.hidden = false;
        progress.value = 0;
        showMessage(status, "Ana shirya lodawa…");
        const details = {
            title: titleInput.value.trim(),
            description: descriptionInput.value.trim()
        };
        const videoFile = videoInput.files[0];
        const posterFile = posterInput.files[0];
        const videoProgressEnd = posterFile ? (videoFile ? 85 : 5) : 100;
        try {
            await uploadMerlinEpisode(
                episode.episodeNumber,
                merlinFormData(details, videoFile),
                (fraction) => {
                    progress.value = fraction * videoProgressEnd;
                    showMessage(status, `Ana lodawa… ${Math.round(fraction * 100)}%`);
                }
            );
            if (posterFile) {
                await uploadMerlinPoster(episode.episodeNumber, posterFile, (fraction) => {
                    progress.value = videoProgressEnd + fraction * (100 - videoProgressEnd);
                    showMessage(status, `Ana lodawa poster… ${Math.round(progress.value)}%`);
                });
            }
            await loadMerlinEpisodes(true);
        } catch (error) {
            await loadMerlinEpisodes();
            showMessage(merlinBulkStatus, `Lodawar Merlin ${String(episode.episodeNumber).padStart(2, "0")} ta samu kuskure: ${error.message}`, true);
            showMessage(status, error.message, true);
        } finally {
            saveButton.disabled = false;
            progress.hidden = true;
        }
    });
    card.appendChild(form);
    return card;
}

async function loadMerlinEpisodes(announce = false) {
    try {
        const data = await adminRequest("/api/admin/merlin");
        merlinEpisodes = data.episodes;
        merlinSlots.replaceChildren(...merlinEpisodes.map(createMerlinSlotCard));
        if (announce) showMessage(merlinBulkStatus, "An sabunta jerin slots na Merlin.");
    } catch (error) {
        merlinSlots.textContent = `An kasa ɗauko slots na Merlin: ${error.message}`;
    }
}

function episodeNumberFromFilename(filename) {
    return merlinEpisodeNumberFromFilename(filename);
}

merlinBulkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const files = [...merlinBulkFiles.files];
    if (!files.length) {
        showMessage(merlinBulkStatus, "Zaɓi fayilolin bidiyo tukuna.", true);
        return;
    }
    const mapped = files.map((file) => ({ file, episodeNumber: episodeNumberFromFilename(file.name) }));
    const episodeNumbers = mapped.map((item) => item.episodeNumber);
    const unparsed = mapped.filter((item) => !item.episodeNumber);
    if (unparsed.length) {
        showMessage(merlinBulkStatus,
            `Ba a gane episode a: ${unparsed.map((item) => item.file.name).join(", ")}. Saka episode 1–10 a sunan fayil.`, true);
        return;
    }
    if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        showMessage(merlinBulkStatus, "Sunan kowane fayil ya ƙunshi lambar episode ta musamman, misali Merlin 01.mp4.", true);
        return;
    }
    const replacements = mapped.filter(({ episodeNumber }) =>
        merlinEpisodes.find((episode) => episode.episodeNumber === episodeNumber)?.hasVideo
    );
    if (replacements.length && !window.confirm(
        `Za a maye gurbin bidiyon slots ${replacements.map((item) => String(item.episodeNumber).padStart(2, "0")).join(", ")}. A ci gaba?`
    )) return;

    merlinBulkButton.disabled = true;
    merlinBulkProgress.hidden = false;
    merlinBulkProgress.value = 0;
    const failures = [];
    for (const [index, item] of mapped.entries()) {
        const slot = merlinEpisodes.find((episode) => episode.episodeNumber === item.episodeNumber);
        const details = {
            title: slot?.title || `Merlin ${String(item.episodeNumber).padStart(2, "0")}`,
            description: slot?.description || ""
        };
        showMessage(merlinBulkStatus, `Ana lodawa ${item.file.name}…`);
        try {
            await uploadMerlinEpisode(item.episodeNumber, merlinFormData(details, item.file), (fraction) => {
                merlinBulkProgress.value = ((index + fraction) / mapped.length) * 100;
            });
        } catch (error) {
            failures.push(`${item.file.name}: ${error.message}`);
        }
        merlinBulkProgress.value = ((index + 1) / mapped.length) * 100;
    }
    merlinBulkFiles.value = "";
    await loadMerlinEpisodes();
    if (failures.length) {
        showMessage(merlinBulkStatus, `An samu kuskure: ${failures.join(" · ")}`, true);
    } else {
        showMessage(merlinBulkStatus, `An loda ${mapped.length} bidiyo na Merlin cikin nasara.`);
    }
    merlinBulkButton.disabled = false;
});

function merlinMovieEpisodeNumberFromFilename(filename) {
    return merlinEpisodeNumberFromFilename(filename);
}

function renderMerlinMovieQueue() {
    merlinMovieQueue.replaceChildren();
    for (const entry of merlinMovieQueueEntries) {
        const card = document.createElement("article");
        card.className = "merlin-movie-queue-card";
        const details = document.createElement("div");
        const title = document.createElement("h4");
        title.textContent = `Episode ${String(entry.episodeNumber).padStart(2, "0")} · ${entry.fileName}`;
        const upload = document.createElement("p");
        if (!Number.isInteger(entry.episodeNumber)) {
            title.textContent = `Episode ba a gane ba · ${entry.fileName}`;
        }
        upload.textContent = `Upload: ${entry.uploadStatus}${entry.uploadStatus === "Uploading" ? ` (${Math.round(entry.uploadPercent)}%)` : ""}`;
        const fingerprint = document.createElement("p");
        fingerprint.className = "queue-status";
        fingerprint.textContent = `Fingerprint: ${entry.fingerprintStatus}`;
        details.append(title, upload, fingerprint);
        const fingerprintPercent = entry.totalSegments
            ? Math.floor((entry.completedSegments / entry.totalSegments) * 100)
            : 0;
        fingerprint.textContent = `Fingerprint: ${entry.fingerprintStatus} · ${entry.completedSegments}/${entry.totalSegments} segments · Failed: ${entry.failedSegments} · ${fingerprintPercent}% · Stage: ${entry.processingStage || entry.fingerprintStatus}`;
        card.appendChild(details);

        if (entry.error) {
            const error = document.createElement("p");
            error.className = "message error";
            error.textContent = entry.error;
            card.appendChild(error);
        }

        if (entry.size > 0) {
            const uploadProgress = document.createElement("progress");
            uploadProgress.max = 100;
            uploadProgress.value = entry.uploadPercent || (entry.uploadStatus === "Completed" ? 100 : 0);
            uploadProgress.setAttribute("aria-label", `Upload progress for ${entry.fileName}`);
            card.appendChild(uploadProgress);
        }
        if (entry.totalSegments > 0) {
            const fingerprintProgress = document.createElement("progress");
            fingerprintProgress.max = entry.totalSegments;
            fingerprintProgress.value = entry.completedSegments;
            fingerprintProgress.setAttribute("aria-label", `Fingerprint progress for ${entry.fileName}`);
            card.appendChild(fingerprintProgress);
            const segments = document.createElement("p");
            segments.textContent = `Progress: ${fingerprintPercent}%`;
            card.appendChild(segments);
        }

        if (entry.jobId && entry.fingerprintStatus === "Failed") {
            const actions = document.createElement("div");
            actions.className = "job-actions";
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "secondary";
            retry.textContent = "Sake gwada fingerprint job";
            retry.addEventListener("click", async () => {
                retry.disabled = true;
                try {
                    await adminRequest(`/api/admin/jobs/${encodeURIComponent(entry.jobId)}/resume`, {
                        method: "POST"
                    });
                    entry.fingerprintStatus = "Pending";
                    entry.error = "";
                    renderMerlinMovieQueue();
                    await refreshMerlinMovieJobs();
                } catch (error) {
                    entry.error = error.message;
                    renderMerlinMovieQueue();
                } finally {
                    retry.disabled = false;
                }
            });
            actions.appendChild(retry);
            card.appendChild(actions);
        }
        merlinMovieQueue.appendChild(card);
    }
}

function uploadMerlinMovie(file, episodeNumber, metadata, onProgress) {
    const formData = new FormData();
    formData.append("episodeNumber", String(episodeNumber));
    formData.append("seasonNumber", "1");
    formData.append("studio", metadata.studio);
    formData.append("year", metadata.year);
    formData.append("language", metadata.language);
    formData.append("actors", metadata.actors);
    formData.append("permissionConfirmed", "true");
    formData.append("movie", file, file.name);
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", window.hfApiUrl("/api/admin/merlin-movies"));
        request.withCredentials = true;
        request.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) onProgress(event.loaded / event.total);
        });
        request.addEventListener("load", () => {
            let payload;
            try {
                payload = request.responseText ? JSON.parse(request.responseText) : {};
            } catch {
                reject(new Error("Amsa daga server ba ta inganta ba."));
                return;
            }
            if (request.status < 200 || request.status >= 300) {
                reject(new Error(payload.error || `Lodawa ta gaza (${request.status}).`));
                return;
            }
            resolve(payload);
        });
        request.addEventListener("error", () => reject(new Error("An kasa haɗuwa da server yayin lodawa.")));
        request.addEventListener("abort", () => reject(new Error("An soke lodawa.")));
        request.send(formData);
    });
}

async function refreshMerlinMovieJobs() {
    if (!merlinMovieQueueEntries.some((entry) => entry.jobId)) return;
    try {
        const data = await adminRequest("/api/admin/jobs");
        const jobsById = new Map(data.jobs.map((job) => [job.id, job]));
        for (const entry of merlinMovieQueueEntries) {
            if (!entry.jobId) continue;
            const job = jobsById.get(entry.jobId);
            if (!job) continue;
            entry.totalSegments = job.total_segments || 0;
            entry.completedSegments = job.completed_segments || 0;
            entry.failedSegments = job.failed_segments || 0;
            entry.error = job.error || "";
            entry.processingStage = job.processing_stage || job.status;
            entry.fingerprintStatus = ({
                waiting: "Pending",
                processing: "Processing",
                completed: "Completed",
                failed: "Failed",
                paused: "Pending"
            })[job.status] || "Pending";
        }
        renderMerlinMovieQueue();
    } catch (error) {
        showMessage(merlinMovieBulkStatus, `An kasa sabunta fingerprint progress: ${error.message}`, true);
    }
}

document.getElementById("selectMerlinMoviesButton").addEventListener("click", () => {
    merlinMovieFiles.click();
});

merlinMovieFiles.addEventListener("change", () => {
    const files = [...merlinMovieFiles.files];
    selectedMerlinMovieNames.textContent = files.length
        ? files.map((file) => file.name).join(" · ")
        : "Ba a zaɓi bidiyo ba tukuna.";
    merlinMovieQueueEntries = files.map((file) => ({
        file,
        fileName: file.name,
        size: file.size,
        episodeNumber: merlinMovieEpisodeNumberFromFilename(file.name),
        uploadStatus: "Pending",
        uploadPercent: 0,
        fingerprintStatus: "Pending",
        processingStage: "pending",
        completedSegments: 0,
        totalSegments: 0,
        failedSegments: 0,
        jobId: null,
        error: ""
    }));
    renderMerlinMovieQueue();
    if (files.length > 10) {
        showMessage(merlinMovieBulkStatus, "Zaɓi har zuwa episodes 10 na season ɗaya a lokaci guda.", true);
    } else {
        showMessage(merlinMovieBulkStatus, files.length ? `${files.length} bidiyo aka zaɓa.` : "");
    }
});

merlinMovieBulkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entries = merlinMovieQueueEntries;
    if (!entries.length || entries.some((entry) => !entry.file)) {
        showMessage(merlinMovieBulkStatus, "Danna SELECT MOVIES ka zaɓi bidiyo tukuna.", true);
        return;
    }
    if (entries.length > 10) {
        showMessage(merlinMovieBulkStatus, "Zaɓi har zuwa episodes 10 na season ɗaya a lokaci guda.", true);
        return;
    }
    const episodeNumbers = entries.map((entry) => entry.episodeNumber);
    const unparsed = entries.filter((entry) => !entry.episodeNumber);
    if (unparsed.length) {
        showMessage(merlinMovieBulkStatus,
            `Ba a gane episode a: ${unparsed.map((entry) => entry.fileName).join(", ")}. Yi amfani da Episode, Epison, Ep, Fita Ta ko S01E01.`, true);
        return;
    }
    if (new Set(episodeNumbers).size !== episodeNumbers.length) {
        showMessage(merlinMovieBulkStatus, "Sunan kowane bidiyo ya nuna episode na musamman daga 01 zuwa 10, misali Merlin Season 1 Episode 01.mp4.", true);
        return;
    }
    const studio = document.getElementById("merlinMovieStudio").value.trim();
    const year = document.getElementById("merlinMovieYear").value.trim();
    const language = document.getElementById("merlinMovieLanguage").value.trim();
    const actors = document.getElementById("merlinMovieActors").value.trim();
    const permissionConfirmed = document.getElementById("merlinMoviePermission").checked;
    if (!studio || !permissionConfirmed) {
        showMessage(merlinMovieBulkStatus, "Saka studio kuma tabbatar da izinin amfani kafin lodawa.", true);
        return;
    }

    const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    let completedBytes = 0;
    merlinMovieUploadProgress.hidden = false;
    merlinMovieUploadProgress.value = 0;
    merlinMovieUploadButton.disabled = true;
    const metadata = { studio, year, language, actors };
    for (const entry of entries) {
        entry.uploadStatus = "Uploading";
        entry.uploadPercent = 0;
        entry.error = "";
        renderMerlinMovieQueue();
        showMessage(merlinMovieBulkStatus, `Ana lodawa ${entry.fileName}…`);
        try {
            const result = await uploadMerlinMovie(
                entry.file,
                entry.episodeNumber,
                metadata,
                (fraction) => {
                    entry.uploadPercent = fraction * 100;
                    merlinMovieUploadProgress.value = totalBytes
                        ? Math.min(100, ((completedBytes + entry.size * fraction) / totalBytes) * 100)
                        : 0;
                    renderMerlinMovieQueue();
                }
            );
            entry.jobId = result.jobId;
            entry.uploadStatus = "Completed";
            entry.uploadPercent = 100;
            entry.fingerprintStatus = "Pending";
            completedBytes += entry.size;
            merlinMovieUploadProgress.value = totalBytes ? (completedBytes / totalBytes) * 100 : 100;
            entry.file = null;
            renderMerlinMovieQueue();
            await refreshMerlinMovieJobs();
            void Promise.all([loadJobs(), loadAdminMovies()]);
        } catch (error) {
            entry.uploadStatus = "Failed";
            entry.fingerprintStatus = "Failed";
            entry.error = error.message;
            entry.file = null;
            renderMerlinMovieQueue();
        }
    }
    merlinMovieFiles.value = "";
    await loadMerlinEpisodes();
    merlinMovieUploadButton.disabled = false;
    const uploaded = entries.filter((entry) => entry.uploadStatus === "Completed").length;
    const failed = entries.length - uploaded;
    showMessage(
        merlinMovieBulkStatus,
        failed
            ? `An loda ${uploaded} cikin ${entries.length}; ${failed} sun kasa. Duba matsayin upload da fingerprint a ƙasa.`
            : `An loda ${uploaded} bidiyo; fingerprint jobs suna aiki a jere. Duba matsayinsu dabam a ƙasa.`,
        failed > 0
    );
    await refreshMerlinMovieJobs();
    await loadJobs();
});

async function loadSocialReports() {
    try {
        const data = await adminRequest("/api/admin/social/reports");
        socialReportsList.replaceChildren();
        if (!data.reports.length) {
            socialReportsList.textContent = "Babu rahoton da yake jira.";
            return;
        }
        for (const report of data.reports) {
            const card = document.createElement("article");
            card.className = "job-card";
            const title = document.createElement("h3");
            title.textContent = `${report.targetType}: ${report.targetUsername || report.targetId}`;
            const details = document.createElement("p");
            details.className = "job-meta";
            details.textContent = `Daga @${report.reporterUsername} · ${report.reason}${report.details ? ` · ${report.details}` : ""}`;
            const actions = document.createElement("div");
            actions.className = "job-actions";
            const choices = [
                ["Warware", "resolve"],
                ["Yi watsi", "dismiss"]
            ];
            if (report.targetType !== "user") choices.push(["Cire abun", "remove-content"]);
            if (report.targetType === "user" || report.targetType === "post") {
                choices.push(["Dakatar da asusu", "suspend-user"]);
            }
            for (const [label, action] of choices) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "secondary";
                button.textContent = label;
                button.addEventListener("click", async () => {
                    if ((action === "remove-content" || action === "suspend-user") &&
                        !window.confirm("Ka tabbatar da wannan matakin gudanarwa?")) return;
                    button.disabled = true;
                    try {
                        await adminRequest(`/api/admin/social/reports/${encodeURIComponent(report.id)}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action })
                        });
                        await loadSocialReports();
                    } catch (error) {
                        showMessage(formMessage, error.message, true);
                        button.disabled = false;
                    }
                });
                actions.appendChild(button);
            }
            card.append(title, details, actions);
            socialReportsList.appendChild(card);
        }
    } catch (error) {
        socialReportsList.textContent = `An kasa ɗauko rahotanni: ${error.message}`;
    }
}

async function loadSocialUsers() {
    try {
        const data = await adminRequest("/api/admin/social/users");
        socialUsersList.replaceChildren();
        if (!data.users.length) {
            socialUsersList.textContent = "Babu asusun al'umma tukuna.";
            return;
        }
        for (const user of data.users) {
            const card = document.createElement("article");
            card.className = "job-card";
            const heading = document.createElement("h3");
            heading.textContent = `${user.fullName} · @${user.username}`;
            const form = document.createElement("form");
            form.className = "moderation-user-form";
            const roleLabel = document.createElement("label");
            roleLabel.textContent = "Matsayi";
            const role = document.createElement("select");
            role.name = "role";
            for (const [value, label] of [["user", "Mai amfani"], ["agent", "Wakili"], ["studio", "Studio"]]) {
                const option = new Option(label, value);
                role.appendChild(option);
            }
            role.value = user.role;
            roleLabel.appendChild(role);
            const groupLabel = document.createElement("label");
            const group = document.createElement("input");
            group.name = "canCreateGroups";
            group.type = "checkbox";
            group.checked = Boolean(user.canCreateGroups);
            groupLabel.append(group, document.createTextNode(" Iya ƙirƙirar ƙungiya"));
            const suspendedLabel = document.createElement("label");
            const suspended = document.createElement("input");
            suspended.name = "suspended";
            suspended.type = "checkbox";
            suspended.checked = Boolean(user.isSuspended);
            suspendedLabel.append(suspended, document.createTextNode(" An dakatar"));
            const save = document.createElement("button");
            save.type = "submit";
            save.textContent = "Ajiye izini";
            form.append(roleLabel, groupLabel, suspendedLabel, save);
            form.addEventListener("submit", async (event) => {
                event.preventDefault();
                save.disabled = true;
                try {
                    await adminRequest(`/api/admin/social/users/${encodeURIComponent(user.id)}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            role: role.value,
                            canCreateGroups: group.checked,
                            suspended: suspended.checked
                        })
                    });
                    showMessage(formMessage, `An sabunta izinin @${user.username}.`);
                    await loadSocialUsers();
                } catch (error) {
                    showMessage(formMessage, error.message, true);
                    save.disabled = false;
                }
            });
            card.append(heading, form);
            socialUsersList.appendChild(card);
        }
    } catch (error) {
        socialUsersList.textContent = `An kasa ɗauko asusun al'umma: ${error.message}`;
    }
}

function addAgentSummaryCard(label, value) {
    const card = document.createElement("article");
    card.className = "owner-agent-card";
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("p");
    detail.textContent = value;
    card.append(title, detail);
    ownerAgentSummary.appendChild(card);
}

async function loadOwnerAgentStatus() {
    showMessage(ownerAgentStatus, "Ana duba matsayin Agent…");
    try {
        const data = await adminRequest("/api/admin/owner-agent/status");
        ownerAgentSummary.replaceChildren();
        const model = data.model;
        addAgentSummaryCard(
            "Local AI",
            !model.configured
                ? "Ba a saita model ba."
                : model.modelAvailable
                    ? "Runtime da model suna nan."
                    : model.runtimeAvailable
                        ? "Runtime yana aiki; model ba ya nan."
                        : "Runtime ba ya amsawa."
        );
        addAgentSummaryCard(
            "SQLite",
            `${data.database.connected ? "Haɗe" : "Ba a haɗe ba"} · integrity: ${data.database.integrity}`
        );
        addAgentSummaryCard(
            "Merlin",
            `${data.merlin.storedEpisodeCount}/${data.merlin.expectedEpisodeCount} slots · ` +
                `${data.merlin.episodes.filter((episode) => episode.videoStored).length} bidiyo suna nan`
        );
        addAgentSummaryCard(
            "Fingerprinting",
            `${data.fingerprints.jobs.reduce((total, item) => total + item.count, 0)} jobs · ` +
                `${data.fingerprints.fingerprints.reduce((total, item) => total + item.count, 0)} records`
        );
        addAgentSummaryCard(
            "Media tools",
            data.mediaTools.map((tool) => `${tool.name}: ${tool.available ? "suna nan" : "ba su nan ba"}`).join(" · ")
        );
        const unavailableRoutes = [
            ...data.routes.backend.filter((route) => !route.available).map((route) => route.route),
            ...data.routes.frontend.filter((route) => !route.present).map((route) => route.route)
        ];
        addAgentSummaryCard(
            "Routes / fayiloli",
            unavailableRoutes.length ? `A duba: ${unavailableRoutes.join(", ")}` : "Dukkan hanyoyin da aka gwada suna nan."
        );
        if (data.recommendations.length) {
            addAgentSummaryCard("Mataki na gaba", data.recommendations.join(" "));
        }
        showMessage(ownerAgentStatus, `${data.agentName} · ${data.mode}. Bincike kawai; ba a canza bayanai ba.`);
    } catch (error) {
        ownerAgentSummary.replaceChildren();
        showMessage(ownerAgentStatus, `An kasa duba Agent: ${error.message}`, true);
    }
}

async function loadOwnerAgentHistory() {
    try {
        const data = await adminRequest("/api/admin/owner-agent/tasks");
        ownerAgentHistory.replaceChildren();
        if (!data.tasks.length && !data.audit.length) {
            ownerAgentHistory.textContent = "Babu tarihin Agent tukuna.";
            return;
        }
        for (const task of data.tasks) {
            const card = document.createElement("article");
            card.className = "job-card";
            const title = document.createElement("h4");
            title.textContent = `${task.type} · ${task.status}`;
            const detail = document.createElement("p");
            detail.className = "job-meta";
            detail.textContent = `${task.createdAt}${task.error ? ` · ${task.error}` : ""}`;
            card.append(title, detail);
            ownerAgentHistory.appendChild(card);
        }
        for (const entry of data.audit) {
            const line = document.createElement("p");
            line.className = "job-meta";
            line.textContent = `${entry.createdAt} · ${entry.actor} · ${entry.action} · ${entry.outcome}`;
            ownerAgentHistory.appendChild(line);
        }
    } catch (error) {
        ownerAgentHistory.textContent = `An kasa ɗauko tarihin Agent: ${error.message}`;
    }
}

async function runOwnerAgentTask(type, button) {
    button.disabled = true;
    ownerAgentResult.textContent = `Ana gudanar da binciken ${type}…`;
    try {
        const data = await adminRequest("/api/admin/owner-agent/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type })
        });
        ownerAgentResult.textContent = JSON.stringify(data.task.result, null, 2);
        await Promise.all([loadOwnerAgentHistory(), loadOwnerAgentStatus()]);
    } catch (error) {
        ownerAgentResult.textContent = `An kasa gudanar da binciken: ${error.message}`;
    } finally {
        button.disabled = false;
    }
}

async function enterDashboard() {
    loginPanel.hidden = true;
    dashboardPanel.hidden = false;
    await Promise.all([
        loadStudios(),
        loadJobs(),
        loadAdminMovies(),
        loadMerlinEpisodes(),
        loadSocialReports(),
        loadSocialUsers(),
        loadOwnerAgentStatus(),
        loadOwnerAgentHistory()
    ]);
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    showMessage(loginMessage, "Ana shiga…");
    const form = new FormData(event.currentTarget);
    try {
        await adminRequest("/api/admin/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: form.get("username"),
                password: form.get("password")
            })
        });
        await enterDashboard();
    } catch (error) {
        showMessage(loginMessage, error.message, true);
    }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
    try {
        await adminRequest("/api/admin/logout", { method: "POST" });
        dashboardPanel.hidden = true;
        loginPanel.hidden = false;
        showMessage(loginMessage, "An fita daga dashboard.");
    } catch (error) {
        if (nativeAdminSessionPlugin) await clearNativeAdminToken();
        showMessage(formMessage, error.message, true);
    }
});

document.getElementById("movieForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = document.getElementById("processButton");
    button.disabled = true;
    showMessage(formMessage, "Ana tura fayiloli da ƙirƙirar aikin sarrafawa…");
    try {
        const data = await adminRequest("/api/admin/movies", {
            method: "POST",
            body: new FormData(form)
        });
        form.reset();
        showMessage(formMessage, `An ajiye fim. Matsayin farko: ${statusName(data.status)}.`);
        await Promise.all([loadJobs(), loadStudios(), loadAdminMovies()]);
    } catch (error) {
        showMessage(formMessage, error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById("studioForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const authorizedLinks = form.elements.authorizedLinks.value
        .split(/\r?\n/)
        .map((link) => link.trim())
        .filter(Boolean);
    try {
        await adminRequest("/api/admin/studios", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: form.elements.name.value.trim(),
                permissionStatus: form.elements.permissionStatus.value,
                authorizedLinks
            })
        });
        form.reset();
        showMessage(studioMessage, "An yi rijistar studio.");
        await loadStudios();
    } catch (error) {
        showMessage(studioMessage, error.message, true);
    }
});

document.getElementById("refreshJobsButton").addEventListener("click", loadJobs);
document.getElementById("refreshMoviesButton").addEventListener("click", loadAdminMovies);
document.getElementById("refreshMerlinButton").addEventListener("click", () => loadMerlinEpisodes(true));
document.getElementById("refreshReportsButton").addEventListener("click", loadSocialReports);
document.getElementById("refreshSocialUsersButton").addEventListener("click", loadSocialUsers);
document.getElementById("refreshOwnerAgentButton").addEventListener("click", loadOwnerAgentStatus);
document.getElementById("refreshOwnerAgentHistoryButton").addEventListener("click", loadOwnerAgentHistory);
document.querySelectorAll("[data-agent-task]").forEach((button) => {
    button.addEventListener("click", () => {
        void runOwnerAgentTask(button.dataset.agentTask, button);
    });
});

function loadAdminSession() {
    adminRequest("/api/admin/me")
        .then(enterDashboard)
        .catch((error) => {
            if (error.message !== "Dole ne mai gudanarwa ya fara shiga.") {
                showMessage(loginMessage, error.message, true);
            }
        });
}

loadAdminSession();
window.addEventListener("hf:server-config-changed", loadAdminSession);

window.setInterval(() => {
    if (!dashboardPanel.hidden) {
        void loadJobs();
        void refreshMerlinMovieJobs();
    }
}, 5000);

async function checkAIAuthAndChat() {
    try {
        const token = getCookie("hf_admin");
        if (!token) {
            showMessage(formMessage, "Sign in to your account to get started.", true);
            aiChatSection.hidden = true;
            return;
        }

        const response = await fetch(window.hfApiUrl("/api/ai/chat"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(nativeAdminSessionPlugin ? {} : { "Cookie": `hf_admin=${token}` })
            },
            body: JSON.stringify({ message: "" }),
            credentials: "include"
        });

        const data = await response.json();

        if (data.requiresAuth) {
            showMessage(formMessage, "Sign in to your account to get started.", true);
            aiChatSection.hidden = true;
        } else if (data.success) {
            aiChatSection.hidden = false;
            showMessage(formMessage, "", false);
            // Add chat message to UI
            addAIMessage(data.response);
        } else {
            showMessage(formMessage, data.error || "An samu kuskure a AI ba.", true);
        }
    } catch (error) {
        showMessage(formMessage, error.message, true);
    }
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(`;`).shift();
    return null;
}

function addAIMessage(text) {
    const messagesDiv = document.getElementById("aiChatMessages");
    const messageDiv = document.createElement("div");
    messageDiv.className = "message ai-message";
    messageDiv.textContent = text;
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function initAIChat() {
    aiChatSection.hidden = true;
    const chatButton = document.getElementById("aiChatButton");
    const chatInput = document.getElementById("aiChatInput");
    const sendButton = document.getElementById("aiChatSend");

    sendButton.addEventListener("click", async () => {
        const message = chatInput.value.trim();
        if (!message) return;

        showMessage(formMessage, "Ubanduwa…", true);

        const token = getCookie("hf_admin");
        const response = await fetch(window.hfApiUrl("/api/ai/chat"), {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(nativeAdminSessionPlugin ? {} : { "Cookie": `hf_admin=${token}` })
            },
            body: JSON.stringify({ message }),
            credentials: "include"
        });

        const data = await response.json();

        if (data.requiresAuth) {
            showMessage(formMessage, "Sign in to your account to get started.", true);
            aiChatSection.hidden = true;
        } else if (data.success) {
            aiChatSection.hidden = false;
            showMessage(formMessage, "", false);
            addAIMessage(data.response);
            chatInput.value = "";
        } else {
            showMessage(formMessage, data.error || "An samu kuskure a AI ba.", true);
        }
    });

    // Allow pressing Enter to send
    chatInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            sendButton.click();
        }
    });
}

// Initialize AI chat section
const aiChatSection = document.createElement("section");
aiChatSection.id = "aiChatSection";
aiChatSection.className = "panel";
aiChatSection.innerHTML = `
    <h2>Mohammad AI</h2>
    <div class="message" id="formMessage" role="status" aria-live="polite"></div>
    <div id="aiChatMessages" style="height: 300px; overflow-y: auto; margin: 10px 0; padding: 10px; background: #f5f5f5; border-radius: 4px;"></div>
    <div style="display: flex; gap: 10px; margin-top: 10px;">
        <input type="text" id="aiChatInput" placeholder="Karba da ranar Hausa..." style="flex: 1; padding: 8px; border: 1px solid #ddd; border-radius: 4px;" />
        <button id="aiChatSend" style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px;">Gurasa</button>
    </div>
`;
document.querySelector(".admin-shell").appendChild(aiChatSection);

initAIChat();
`;
