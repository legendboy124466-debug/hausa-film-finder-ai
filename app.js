const catalogStatus = document.getElementById("catalogStatus");
const moviesContainer = document.getElementById("moviesContainer");
const categoryFilters = document.getElementById("categoryFilters");
const identificationResult = document.getElementById("identificationResult");
const catalogSection = document.getElementById("movies");
const movieDetailSection = document.getElementById("movieDetailSection");
const movieDetailPoster = document.getElementById("movieDetailPoster");
const movieDetailStatus = document.getElementById("movieDetailStatus");
const movieDetailTitle = document.getElementById("movieDetailTitle");
const movieDetailMeta = document.getElementById("movieDetailMeta");
const movieDetailEpisode = document.getElementById("movieDetailEpisode");
const movieDetailDescription = document.getElementById("movieDetailDescription");
const playMovieButton = document.getElementById("playMovieButton");
const moviePlaybackStatus = document.getElementById("moviePlaybackStatus");
const movieVideoPlayer = document.getElementById("movieVideoPlayer");
const merlinEpisodesContainer = document.getElementById("merlinEpisodes");
const merlinStatus = document.getElementById("merlinStatus");
const merlinPlayerDialog = document.getElementById("merlinPlayerDialog");
const merlinVideoPlayer = document.getElementById("merlinVideoPlayer");
const merlinPlayerTitle = document.getElementById("merlinPlayerTitle");
const merlinPlayerStatus = document.getElementById("merlinPlayerStatus");
let movies = [];
let selectedCategory = "";
let selectedMovie = null;
const merlinSeasonOnePosterUrl = "/legacy-merlin-poster";
const merlinSeasonOneDetailsUrl = "/merlin-poster.html";

function isMerlinSeasonOne(movie) {
    const titles = [movie.title, movie.originalTitle, movie.hausaTitle]
        .filter((title) => typeof title === "string")
        .map((title) => title.trim().toLowerCase());
    return titles.some((title) => title.includes("merlin") || title === "malin");
}

function createMerlinPosterLink(poster, label) {
    const link = document.createElement("a");
    link.className = "movie-poster-link";
    link.href = merlinSeasonOneDetailsUrl;
    link.setAttribute("aria-label", label);
    link.appendChild(poster);
    return link;
}

async function apiRequest(url, options = {}) {
    console.log("[HF] app.js apiRequest:", url, options);
    const response = await fetchWithRetry(window.hfApiUrl(url), { credentials: "include", ...options });
    const payload = await response.json().catch(() => ({}));
    console.log("[HF] app.js apiRequest response:", response.status, payload);
    if (!response.ok) throw new Error(payload.error || `Buƙatar ta gaza (${response.status}).`);
    return payload;
}

const API_TIMEOUT_MS = 30000;
const API_MAX_RETRIES = 3;

async function fetchWithRetry(input, init) {
    let lastError;
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
            const response = await fetch(input, { ...init, signal: controller.signal });
            clearTimeout(timeout);
            return response;
        } catch (error) {
            clearTimeout(timeout);
            lastError = error;
            if (error.name === "AbortError") {
                throw new Error("Server ƙara ta ɗauki lokaci (timeout). Gwada sake aikawa.");
            }
            if (attempt < API_MAX_RETRIES && error instanceof TypeError) {
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return "Ba a tantance ba";
    const totalMinutes = Math.floor(seconds / 60);
    return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

function movieStatusName(status) {
    return {
        waiting: "Pending · Ana jira",
        processing: "Processing · Ana sarrafawa",
        completed: "Completed · An kammala",
        failed: "Failed · An kasa"
    }[status] || "Pending · Ana jira";
}

function createMovieCard(movie) {
    const isMerlin = isMerlinSeasonOne(movie);
    const card = document.createElement("article");
    card.className = isMerlin
        ? "movie-card featured-movie-card"
        : "movie-card";
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute("aria-label", `Duba bayanan fim ɗin ${movie.title}`);
    card.addEventListener("click", (event) => {
        if (event.target.closest("button, a, summary")) return;
        void openMovieDetails(movie.id);
    });
    card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.target.closest("button, a, summary")) {
            event.preventDefault();
            void openMovieDetails(movie.id);
        }
    });

    if (movie.posterUrl || isMerlin) {
        const poster = document.createElement("img");
        poster.className = "movie-poster";
        poster.src = window.hfApiUrl(movie.posterUrl || (isMerlin ? merlinSeasonOnePosterUrl : ""));
        poster.alt = `Poster: ${movie.title}`;
        poster.loading = "lazy";
        poster.onerror = () => {
            const fallback = document.createElement("div");
            fallback.className = "movie-poster poster-missing";
            fallback.textContent = isMerlin ? "MERLIN SEASON 1" : "BA A SAMU POSTER BA";
            poster.replaceWith(fallback);
        };
        card.appendChild(isMerlin
            ? createMerlinPosterLink(poster, "Duba bayanan fim ɗin MERLIN")
            : poster);
    } else {
        const fallback = document.createElement("div");
        fallback.className = "movie-poster poster-missing";
        fallback.textContent = "BA A SAMU POSTER BA";
        card.appendChild(fallback);
    }

    const copy = document.createElement("div");
    copy.className = "movie-copy";
    const title = document.createElement("h3");
    title.textContent = movie.hausaTitle
        ? `${movie.hausaTitle} · ${movie.originalTitle || movie.title}`
        : movie.title;
    copy.appendChild(title);

    const detailsText = [
        movie.studio,
        movie.language,
        movie.country,
        movie.year,
        movie.durationSeconds ? formatDuration(movie.durationSeconds) : null
    ].filter(Boolean).join(" · ");
    const details = document.createElement("p");
    details.textContent = detailsText || "Ba a saka cikakkun bayanai ba tukuna.";
    copy.appendChild(details);
    if (movie.actors?.length) {
        const cast = document.createElement("p");
        cast.textContent = `Jarumai: ${movie.actors.join(" · ")}`;
        copy.appendChild(cast);
    }

    const status = document.createElement("p");
    status.className = "movie-status";
    status.textContent = movieStatusName(movie.processingStatus);
    copy.appendChild(status);

    if (movie.description) {
        const description = document.createElement("p");
        description.textContent = movie.description;
        copy.appendChild(description);
    }
    if (movie.categories?.length) {
        const categories = document.createElement("p");
        categories.textContent = movie.categories.join(" · ");
        copy.appendChild(categories);
    }
    if (movie.episodes?.length) {
        const list = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Jerin episodes";
        const episodes = document.createElement("ul");
        for (const episode of movie.episodes) {
            const item = document.createElement("li");
            item.textContent = typeof episode === "string"
                ? episode
                : episode.title || [
                    episode.seasonNumber ? `Season ${episode.seasonNumber}` : null,
                    episode.episodeNumber ? `Episode ${episode.episodeNumber}` : null
                ].filter(Boolean).join(" · ") || `Episode ${episode.number || ""}`;
            episodes.appendChild(item);
        }
        list.append(summary, episodes);
        copy.appendChild(list);
    }
    card.appendChild(copy);
    const actions = document.createElement("div");
    actions.className = "movie-social-actions";
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.dataset.favoriteMovie = movie.id;
    favorite.textContent = "♡ Ajiye a favorites";
    const review = document.createElement("button");
    review.type = "button";
    review.dataset.reviewMovie = movie.id;
    review.textContent = "Rubuta review";
    actions.append(favorite, review);
    card.appendChild(actions);
    return card;
}

function renderMovies(list) {
    moviesContainer.replaceChildren();
    window.hfCurrentMovies = movies;
    window.dispatchEvent(new CustomEvent("hf:movies", { detail: { movies } }));
    const filtered = selectedCategory
        ? list.filter((movie) => movie.categories?.includes(selectedCategory))
        : list;
    if (filtered.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = list.length
            ? "Babu fim a wannan rukuni."
            : "Babu fim a kundin tukuna. Mai gudanarwa zai ƙara bayanai bayan tabbatar da izinin amfani.";
        moviesContainer.appendChild(empty);
        return;
    }
    let merlinCardAdded = false;
    for (const movie of filtered) {
        if (isMerlinSeasonOne(movie)) {
            if (merlinCardAdded) continue;
            merlinCardAdded = true;
        }
        moviesContainer.appendChild(createMovieCard(movie));
    }
}

function renderCategories() {
    categoryFilters.replaceChildren();
    const categories = [...new Set(movies.flatMap((movie) => movie.categories || []))].sort();
    if (!categories.length) return;
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.textContent = "Duka";
    allButton.setAttribute("aria-pressed", String(!selectedCategory));
    allButton.addEventListener("click", () => {
        selectedCategory = "";
        renderCategories();
        renderMovies(movies);
    });
    categoryFilters.appendChild(allButton);
    for (const category of categories) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = category;
        button.setAttribute("aria-pressed", String(selectedCategory === category));
        button.addEventListener("click", () => {
            selectedCategory = category;
            renderCategories();
            renderMovies(movies);
        });
        categoryFilters.appendChild(button);
    }
}

async function loadMovies(query = "") {
    catalogStatus.textContent = "Ana É—auko bayanan fimâ€¦";
    try {
        const path = query ? `/api/movies?q=${encodeURIComponent(query)}` : "/api/movies";
        const data = await apiRequest(path);
        movies = data.movies;
        selectedCategory = "";
        catalogStatus.textContent = `${movies.length} ${movies.length === 1 ? "fim" : "fina-finai"} aka samu.`;
        renderCategories();
        renderMovies(movies);
        const movieId = new URLSearchParams(window.location.search).get("movie");
        if (movieId) await openMovieDetails(movieId, { updateHistory: false });
    } catch (error) {
        catalogStatus.textContent = `An kasa ɗauko kundin fina-finai: ${error.message}`;
        renderMovies([]);
    }
}

async function openMovieDetails(movieId, { updateHistory = true } = {}) {
    selectedMovie = null;
    movieDetailSection.hidden = false;
    catalogSection.hidden = true;
    movieDetailTitle.textContent = "Ana ɗauko bayanan fim…";
    movieDetailMeta.textContent = "";
    movieDetailEpisode.textContent = "";
    movieDetailDescription.textContent = "";
    movieDetailStatus.textContent = "";
    moviePlaybackStatus.textContent = "";
    movieDetailPoster.hidden = true;
    playMovieButton.disabled = true;
    resetMovieVideo();
    if (updateHistory) {
        window.history.pushState({ movieId }, "", `/?movie=${encodeURIComponent(movieId)}`);
    }
    movieDetailSection.scrollIntoView({ behavior: "smooth", block: "start" });

    try {
        const { movie } = await apiRequest(`/api/movies/${encodeURIComponent(movieId)}`);
        selectedMovie = movie;
        movieDetailTitle.textContent = movie.hausaTitle
            ? `${movie.hausaTitle} · ${movie.originalTitle || movie.title}`
            : movie.title;
        movieDetailMeta.textContent = [
            movie.studio,
            movie.language,
            movie.country,
            movie.year,
            movie.durationSeconds ? formatDuration(movie.durationSeconds) : null
        ].filter(Boolean).join(" · ");
        if (movie.actors?.length) {
            movieDetailMeta.textContent += ` · Jarumai: ${movie.actors.join(", ")}`;
        }
        const episode = movie.episodes?.find((item) => item && typeof item === "object");
        movieDetailEpisode.textContent = episode
            ? [
                episode.seasonNumber ? `Season ${episode.seasonNumber}` : null,
                episode.episodeNumber ? `Episode ${episode.episodeNumber}` : null
            ].filter(Boolean).join(" · ")
            : "";
        movieDetailDescription.textContent = movie.description || "Ba a saka bayani ba tukuna.";
        movieDetailStatus.textContent = `Fingerprint: ${movieStatusName(movie.processingStatus)}`;
        if (movie.posterUrl) {
            movieDetailPoster.src = window.hfApiUrl(movie.posterUrl);
            movieDetailPoster.alt = `Poster: ${movie.title}`;
            movieDetailPoster.hidden = false;
        }
        playMovieButton.disabled = !movie.hasVideo;
        if (!movie.hasVideo) moviePlaybackStatus.textContent = "Ba a sami fayil ɗin bidiyo ba.";
    } catch (error) {
        movieDetailTitle.textContent = "An kasa buɗe bayanan fim";
        moviePlaybackStatus.textContent = error.message;
    }
}

function resetMovieVideo() {
    movieVideoPlayer.pause();
    movieVideoPlayer.removeAttribute("src");
    movieVideoPlayer.hidden = true;
    movieVideoPlayer.muted = false;
    movieVideoPlayer.volume = 1;
    movieVideoPlayer.load();
}

function closeMovieDetails({ updateHistory = true } = {}) {
    movieDetailSection.hidden = true;
    catalogSection.hidden = false;
    selectedMovie = null;
    resetMovieVideo();
    if (updateHistory) window.history.pushState({}, "", "/#movies");
}

document.getElementById("backToMoviesButton").addEventListener("click", () => closeMovieDetails());
playMovieButton.addEventListener("click", () => {
    if (!selectedMovie?.hasVideo) return;
    moviePlaybackStatus.textContent = "Ana buɗe bidiyo…";
    movieVideoPlayer.src = window.hfApiUrl(`/api/movies/${encodeURIComponent(selectedMovie.id)}/video`);
    movieVideoPlayer.hidden = false;
    movieVideoPlayer.muted = false;
    movieVideoPlayer.volume = 1;
    movieVideoPlayer.load();
    const playback = movieVideoPlayer.play();
    if (playback) {
        playback.then(() => {
            moviePlaybackStatus.textContent = "Bidiyo yana kunne da sauti.";
        }).catch(() => {
            moviePlaybackStatus.textContent = "Chrome bai fara bidiyon ba. Danna PLAY a cikin bidiyon ko gwada fayil MP4 mai H.264 da AAC.";
        });
    }
});
movieVideoPlayer.addEventListener("error", () => {
    moviePlaybackStatus.textContent = "Chrome bai iya karanta codec ɗin bidiyon ba. Gwada MP4 mai H.264 da AAC; ba a kashe sautin bidiyon ba.";
});
window.addEventListener("popstate", () => {
    const movieId = new URLSearchParams(window.location.search).get("movie");
    if (movieId) void openMovieDetails(movieId, { updateHistory: false });
    else closeMovieDetails({ updateHistory: false });
});

function createMerlinEpisodeCard(episode) {
    const card = document.createElement("article");
    card.className = "merlin-card";
    const poster = document.createElement("img");
    poster.className = "merlin-poster";
    poster.src = window.hfApiUrl(episode.posterUrl || merlinSeasonOnePosterUrl);
    poster.alt = `Poster na MERLIN Season 1 — ${episode.title}`;
    poster.loading = "lazy";
    poster.onerror = () => {
        const fallback = document.createElement("div");
        fallback.className = "merlin-poster merlin-poster-empty";
        fallback.textContent = "MERLIN SEASON 1";
        poster.replaceWith(fallback);
    };
    card.appendChild(createMerlinPosterLink(poster, `Duba bayanan fim ɗin MERLIN Season 1 — ${episode.title}`));

    const content = document.createElement("div");
    content.className = "merlin-card-content";
    const heading = document.createElement("h3");
    heading.textContent = episode.title;
    const number = document.createElement("p");
    number.textContent = `Episode ${String(episode.episodeNumber).padStart(2, "0")}`;
    content.append(heading, number);
    if (episode.description) {
        const description = document.createElement("p");
        description.textContent = episode.description;
        content.appendChild(description);
    }
    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.className = "merlin-play-button";
    playButton.textContent = episode.hasVideo ? "Kunna episode" : "Ba a ɗora bidiyo ba";
    playButton.disabled = !episode.hasVideo;
    if (episode.hasVideo) {
        playButton.addEventListener("click", () => openMerlinPlayer(episode));
    }
    content.appendChild(playButton);
    card.appendChild(content);
    return card;
}

function openMerlinPlayer(episode) {
    merlinPlayerTitle.textContent = episode.title;
    merlinPlayerStatus.textContent = "";
    merlinVideoPlayer.src = window.hfApiUrl(episode.videoUrl);
    merlinVideoPlayer.poster = episode.posterUrl || merlinSeasonOnePosterUrl;
    merlinVideoPlayer.load();
    merlinPlayerDialog.showModal();
    const playback = merlinVideoPlayer.play();
    if (playback) {
        playback.catch(() => {
            merlinPlayerStatus.textContent = "Danna maɓallin play idan bidiyon bai fara ba.";
        });
    }
}

async function loadMerlinEpisodes() {
    merlinStatus.textContent = "Ana ɗauko tarin Merlin…";
    try {
        const data = await apiRequest("/api/merlin");
        merlinEpisodesContainer.replaceChildren(
            ...data.episodes.map(createMerlinEpisodeCard)
        );
        merlinStatus.textContent = `${data.episodes.length} slots na Merlin.`;
    } catch (error) {
        merlinStatus.textContent = `An kasa ɗauko tarin Merlin: ${error.message}`;
    }
}

document.getElementById("closeMerlinPlayer").addEventListener("click", () => {
    merlinPlayerDialog.close();
});
merlinPlayerDialog.addEventListener("close", () => {
    merlinVideoPlayer.pause();
    merlinVideoPlayer.removeAttribute("src");
    merlinVideoPlayer.removeAttribute("poster");
    merlinVideoPlayer.load();
});
merlinVideoPlayer.addEventListener("error", () => {
    merlinPlayerStatus.textContent = "An kasa kunna bidiyon. A iPhone/Safari, yi amfani da MP4 mai H.264 da AAC; wasu codecs ba sa aiki.";
});

function renderIdentification(data, target) {
    target.replaceChildren();
    if (!data.identified) {
        const message = document.createElement("p");
        message.className = "empty-state";
        message.textContent = data.message;
        target.appendChild(message);
        return;
    }
    const movie = data.movie;
    const card = document.createElement("article");
    card.className = "result-card";
    if (movie.posterUrl || isMerlinSeasonOne(movie)) {
        const poster = document.createElement("img");
        const isMerlin = isMerlinSeasonOne(movie);
        poster.src = window.hfApiUrl(movie.posterUrl || (isMerlin ? merlinSeasonOnePosterUrl : ""));
        poster.alt = `Poster: ${movie.title}`;
        card.appendChild(isMerlin
            ? createMerlinPosterLink(poster, "Duba bayanan fim ɗin MERLIN")
            : poster);
    }
    const copy = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = movie.title;
    const facts = document.createElement("p");
    facts.textContent = [
        movie.hausaTitle,
        movie.originalTitle,
        movie.studio,
        movie.language,
        movie.episode?.seasonNumber ? `Season ${movie.episode.seasonNumber}` : null,
        movie.episode?.episodeNumber ? `Episode ${movie.episode.episodeNumber}` : null,
        movie.durationSeconds ? formatDuration(movie.durationSeconds) : null
    ].filter(Boolean).join(" · ");
    const timestamp = document.createElement("p");
    timestamp.textContent = `Wurin da aka yi daidai: ${formatDuration(movie.timestampSeconds)}`;
    const confidence = document.createElement("p");
    confidence.className = "match-confidence";
    confidence.textContent = `Daidaiton fingerprint: ${movie.confidence}% · ${movie.matchedBy}`;
    copy.append(title, facts, timestamp, confidence);
    card.appendChild(copy);
    target.appendChild(card);
}

document.getElementById("searchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    loadMovies(new FormData(event.currentTarget).get("q").trim());
});

document.querySelectorAll(".identify-card").forEach((form) => {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button");
        button.disabled = true;
        button.textContent = "Ana tantancewa…";
        identificationResult.textContent = "";
        try {
            const data = await apiRequest(`/api/identify/${form.dataset.kind}`, {
                method: "POST",
                body: new FormData(form)
            });
            renderIdentification(data, identificationResult);
        } catch (error) {
            const message = document.createElement("p");
            message.className = "empty-state";
            message.textContent = `An kasa tantance samfurin: ${error.message}`;
            identificationResult.replaceChildren(message);
        } finally {
            button.disabled = false;
            button.textContent = form.dataset.kind === "image"
                ? "Gano daga hoto"
                : form.dataset.kind === "audio"
                    ? "Gano daga sauti"
                    : "Gano daga bidiyo";
        }
    });
});

const cameraDialog = document.getElementById("cameraDialog");
const cameraPreview = document.getElementById("cameraPreview");
const cameraDialogStatus = document.getElementById("cameraDialogStatus");
let stillCameraStream = null;

function explainCaptureError(error) {
    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
        return "Ba a ba app izinin camera ko makirufo ba. Ka ba da izini sannan ka sake gwadawa.";
    }
    if (error?.name === "NotFoundError" || error?.name === "DevicesNotFoundError") {
        return "Ba a sami camera ko makirufo a wannan na'urar ba.";
    }
    if (error?.name === "NotReadableError" || error?.name === "TrackStartError") {
        return "Wani app na amfani da camera ko makirufo. Rufe shi sannan ka sake gwadawa.";
    }
    if (error?.name === "NotSupportedError") {
        return "Wannan na'urar ba ta tallafa wa rikodi kai tsaye ba. Zaɓi fayil daga wayarka.";
    }
    return error?.message || "An kasa amfani da camera ko makirufo. Zaɓi fayil daga wayarka.";
}

function setIdentificationFile(form, blob, filename) {
    const input = form.querySelector('input[name="sample"]');
    const file = new File([blob], filename, { type: blob.type || "application/octet-stream" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function stopStillCamera() {
    stillCameraStream?.getTracks().forEach((track) => track.stop());
    stillCameraStream = null;
    cameraPreview.srcObject = null;
}

document.querySelector("[data-take-photo]")?.addEventListener("click", async () => {
    cameraDialogStatus.textContent = "Ana buɗe camera…";
    cameraDialog.showModal();
    try {
        stillCameraStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false
        });
        cameraPreview.srcObject = stillCameraStream;
        await cameraPreview.play();
        cameraDialogStatus.textContent = "Ka daidaita hoton, sannan ka taɓa Ɗauki hoto.";
    } catch (error) {
        cameraDialogStatus.textContent = explainCaptureError(error);
    }
});

document.getElementById("closeCameraButton")?.addEventListener("click", () => cameraDialog.close());
cameraDialog?.addEventListener("close", stopStillCamera);
document.getElementById("takePhotoButton")?.addEventListener("click", () => {
    const form = document.querySelector('.identify-card[data-kind="image"]');
    const status = form?.querySelector('[data-capture-status="image"]');
    if (!cameraPreview.videoWidth || !cameraPreview.videoHeight) {
        cameraDialogStatus.textContent = "Jira camera ta nuna hoto kafin ɗauka.";
        return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = cameraPreview.videoWidth;
    canvas.height = cameraPreview.videoHeight;
    canvas.getContext("2d").drawImage(cameraPreview, 0, 0);
    canvas.toBlob((blob) => {
        if (!blob) {
            cameraDialogStatus.textContent = "An kasa ƙirƙirar hoton.";
            return;
        }
        setIdentificationFile(form, blob, "hoton-camera.jpg");
        status.textContent = "An ɗauki hoto. Taɓa Gano daga hoto don ci gaba.";
        cameraDialog.close();
    }, "image/jpeg", 0.9);
});

document.querySelectorAll("[data-record-media]").forEach((button) => {
    let recorder = null;
    let activeStream = null;
    let stopTimer = null;
    button.addEventListener("click", async () => {
        const kind = button.dataset.recordMedia;
        const form = button.closest(".identify-card");
        const status = form.querySelector(`[data-capture-status="${kind}"]`);
        if (recorder?.state === "recording") {
            recorder.stop();
            button.disabled = true;
            button.textContent = "Ana kammala rikodi…";
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            status.textContent = explainCaptureError({ name: "NotSupportedError" });
            return;
        }
        button.disabled = true;
        status.textContent = kind === "audio" ? "Ana buƙatar izinin makirufo…" : "Ana buƙatar izinin camera da makirufo…";
        try {
            activeStream = await navigator.mediaDevices.getUserMedia(kind === "audio"
                ? { audio: true }
                : { video: { facingMode: { ideal: "environment" } }, audio: true });
            const options = {};
            const preferredTypes = kind === "audio"
                ? ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
                : ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
            options.mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
            recorder = new MediaRecorder(activeStream, options.mimeType ? options : undefined);
            const chunks = [];
            recorder.addEventListener("dataavailable", (event) => {
                if (event.data.size) chunks.push(event.data);
            });
            recorder.addEventListener("error", (event) => {
                status.textContent = explainCaptureError(event.error);
            });
            recorder.addEventListener("stop", () => {
                clearTimeout(stopTimer);
                activeStream?.getTracks().forEach((track) => track.stop());
                activeStream = null;
                const type = recorder.mimeType || (kind === "audio" ? "audio/webm" : "video/webm");
                const extension = type.includes("mp4") ? (kind === "audio" ? "m4a" : "mp4") : "webm";
                const blob = new Blob(chunks, { type });
                if (blob.size) {
                    setIdentificationFile(form, blob, `rikodi.${extension}`);
                    status.textContent = "An shirya rikodin. Taɓa maɓallin ganowa don ci gaba.";
                } else {
                    status.textContent = "Rikodin bai ƙunshi sauti ko bidiyo ba. Sake gwadawa.";
                }
                button.disabled = false;
                button.textContent = kind === "audio" ? "Yi rikodin sauti na sakan 20" : "Yi rikodin bidiyo na sakan 20";
            }, { once: true });
            recorder.start(500);
            status.textContent = "Ana rikodi… zai tsaya da kansa bayan sakan 20.";
            button.textContent = "Tsaya rikodi yanzu";
            button.disabled = false;
            stopTimer = setTimeout(() => {
                if (recorder?.state === "recording") recorder.stop();
            }, 20_000);
        } catch (error) {
            activeStream?.getTracks().forEach((track) => track.stop());
            activeStream = null;
            button.disabled = false;
            status.textContent = explainCaptureError(error);
        }
    });
});

const assistantForm = document.getElementById("assistantForm");
const assistantInput = document.getElementById("chatInput");
const assistantSendButton = document.getElementById("assistantSendButton");
const assistantMessages = document.getElementById("chatMessages");
const assistantModelStatus = document.getElementById("mohammadModelStatus");
const assistantRequestStatus = document.getElementById("assistantRequestStatus");
let assistantHistory = [];
let assistantAuthenticated = false;
let assistantController = null;
let assistantSpeaking = false;

function appendAssistantMessage(role, text, isError = false) {
    const message = document.createElement("p");
    message.className = `chat-message${isError ? " error" : ""}`;
    message.textContent = `${role === "user" ? "Kai" : "Mohammad AI"}: ${text}`;
    assistantMessages.appendChild(message);
    assistantMessages.scrollTop = assistantMessages.scrollHeight;
    return message;
}

function setAssistantSpeaking(speaking) {
    assistantSpeaking = speaking;
    const avatar = document.querySelector(".assistant-avatar");
    if (avatar) {
        if (speaking) {
            avatar.classList.add("speaking");
        } else {
            avatar.classList.remove("speaking");
        }
    }
    const status = document.getElementById("assistantRequestStatus");
    if (status) {
        status.textContent = speaking ? "Mohammad AI yana kunna…" : "";
    }
}

function speakText(text) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ha";
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.onstart = () => setAssistantSpeaking(true);
    utterance.onend = () => setAssistantSpeaking(false);
    utterance.onerror = () => setAssistantSpeaking(false);
    try {
        window.speechSynthesis.speak(utterance);
    } catch {
        setAssistantSpeaking(false);
    }
}

async function loadMohammadStatus(authenticated) {
    console.log("[HF] loadMohammadStatus called with:", authenticated);
    assistantAuthenticated = authenticated;
    assistantInput.disabled = false;
    assistantSendButton.disabled = false;
    assistantInput.placeholder = "Rubuta tambayarka...";
    if (!authenticated) {
        assistantController?.abort();
        assistantController = null;
        assistantHistory = [];
        assistantMessages.replaceChildren();
        assistantMessages.appendChild(Object.assign(document.createElement("p"), {
            className: "chat-message",
            textContent: "Koyon ka iya hira da Mohammad AI ba a buƙatar shiga asusu. Rubuta tambayarka yanzu."
        }));
        assistantModelStatus.textContent = "Mohammad AI yana aiki (koyon).";
        assistantRequestStatus.textContent = "";
        return;
    }

    assistantModelStatus.textContent = "Ana duba local AI…";
    try {
        const status = await apiRequest("/api/mohammad-ai/status");
        assistantModelStatus.textContent = status.modelAvailable
            ? "Local AI yana aiki."
            : !status.modelConfigured
                ? "Ba a zaɓi ko shigar da local AI model ba."
                : !status.runtimeAvailable
                    ? "Ollama ba ya aiki a yanzu."
                    : "Ba a samu model ɗin da aka zaɓa ba.";
    } catch (error) {
        assistantModelStatus.textContent = `Ba a iya duba matsayin AI: ${error.message}`;
    }
}

window.addEventListener("hf:auth", (event) => {
    console.log("[HF] app.js received hf:auth event:", event.detail);
    void loadMohammadStatus(Boolean(event.detail?.authenticated));
});

assistantForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = assistantInput.value.trim();
    if (!question) return;
    appendAssistantMessage("user", question);
    assistantInput.value = "";
    assistantSendButton.disabled = true;
    assistantRequestStatus.textContent = "Mohammad AI yana tunani…";
    const answer = appendAssistantMessage("assistant", "");
    assistantController = new AbortController();
    try {
        const response = await fetch(window.hfApiUrl("/api/mohammad-ai/chat"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: question, history: assistantHistory }),
            signal: assistantController.signal
        });
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Buƙatar ta gaza (${response.status}).`);
        }
        if (!response.body) throw new Error("Browser bai goyi bayan karɓar amsa a hankali ba.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        let answerText = "";
        let streamError = "";
        const appendLine = (line) => {
            if (!line.trim()) return;
            const payload = JSON.parse(line);
            if (typeof payload.token === "string") answerText += payload.token;
            if (typeof payload.error === "string") streamError = payload.error;
            answer.textContent = `Mohammad AI: ${answerText || streamError}`;
            assistantMessages.scrollTop = assistantMessages.scrollHeight;
        };
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                pending += decoder.decode(value, { stream: true });
                const lines = pending.split("\n");
                pending = lines.pop() || "";
                for (const line of lines) appendLine(line);
            }
            pending += decoder.decode();
            if (pending.trim()) appendLine(pending);
        } finally {
            reader.releaseLock();
        }
        if (streamError) throw new Error(streamError);
        if (!answerText) throw new Error("Mohammad AI bai amsa ba. Gwada sake aikawa.");
        answer.textContent = `Mohammad AI: ${answerText}`;
        assistantHistory = [
            ...assistantHistory,
            { role: "user", content: question },
            { role: "assistant", content: answerText }
        ].slice(-8);
        assistantRequestStatus.textContent = "";
        // Speak the response using free browser-native TTS
        speakText(answerText);
    } catch (error) {
        if (error.name !== "AbortError") {
            answer.classList.add("error");
            answer.textContent = `Mohammad AI bai amsa ba: ${error.message}`;
            assistantRequestStatus.textContent = "An kasa kammala amsar. Za ka iya sake gwadawa.";
        }
    } finally {
        assistantController = null;
        assistantSendButton.disabled = false;
    }
});

const welcomeMessage = "Assalamu Alaikum! Barka da zuwa HAUSA FILM FINDER. Ni ne Mohammad AI, mataimakinka. Zan taimaka maka gano fina-finai, jarumai, studios da duk bayanan da kake bukata.";
const replayWelcomeButton = document.getElementById("replayWelcome");
const toggleWelcomeMuteButton = document.getElementById("toggleWelcomeMute");
const welcomeMuteLabel = document.getElementById("welcomeMuteLabel");
const welcomeVoiceStatus = document.getElementById("welcomeVoiceStatus");
const welcomeRecording = document.getElementById("welcomeRecording");
let welcomeMuted = false;
let welcomeAutoAttempted = false;
let welcomeActive = false;
let welcomeHasPlayed = false;
let welcomeRequestPending = false;
let welcomePlaybackId = 0;
let welcomeFirstInteractionHandler = null;

try {
    welcomeMuted = localStorage.getItem("hf-welcome-muted") === "true";
} catch {
    welcomeVoiceStatus.textContent = "Ba a iya karanta saitin sauti da aka adana a wannan browser ba.";
    welcomeVoiceStatus.classList.add("error");
}

function updateWelcomeMuteControl() {
    toggleWelcomeMuteButton.setAttribute("aria-pressed", String(welcomeMuted));
    toggleWelcomeMuteButton.setAttribute(
        "aria-label",
        welcomeMuted ? "Kunna sautin maraba" : "Kashe sautin maraba"
    );
    welcomeMuteLabel.textContent = welcomeMuted ? "Kunna sauti" : "Kashe sauti";
}

function setWelcomeStatus(message, isError = false) {
    welcomeVoiceStatus.textContent = message;
    welcomeVoiceStatus.classList.toggle("error", isError);
}

function findHausaVoice() {
    if (!("speechSynthesis" in window)) return null;
    return window.speechSynthesis.getVoices()
        .find((voice) => /^ha(?:[-_]|$)/i.test(voice.lang)) || null;
}

function stopWelcomePlayback() {
    welcomePlaybackId += 1;
    welcomeActive = false;
    welcomeRequestPending = false;
    welcomeRecording.pause();
    welcomeRecording.currentTime = 0;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function playRecordedWelcome(playbackId) {
    welcomeRecording.currentTime = 0;
    let playback;
    try {
        playback = welcomeRecording.play();
    } catch (error) {
        showWelcomeRecordingError(error, playbackId);
        return;
    }
    if (playback && typeof playback.then === "function") {
        playback.then(() => {
            if (playbackId !== welcomePlaybackId || welcomeMuted) return;
            welcomeRequestPending = false;
            welcomeActive = true;
            welcomeHasPlayed = true;
            setWelcomeStatus("Ana kunna rikodin maraba da Hausa.");
        }).catch((error) => {
            welcomeRequestPending = false;
            showWelcomeRecordingError(error, playbackId);
        });
    } else {
        welcomeRequestPending = false;
        welcomeActive = true;
        welcomeHasPlayed = true;
        setWelcomeStatus("Ana kunna rikodin maraba da Hausa.");
    }
}

function showWelcomeRecordingError(error, playbackId) {
    if (playbackId !== welcomePlaybackId || welcomeMuted) return;
    welcomeActive = false;
    if (error?.name === "NotAllowedError") {
        setWelcomeStatus("Browser ya hana autoplay. Taɓa ko danna Saurari maraba domin sauraro.", true);
        return;
    }
    setWelcomeStatus(
        "Ba a samu muryar Hausa ba. Domin ƙara ingantaccen rikodi, saka hausa-welcome.mp3 a babban fayil ɗin assets.",
        true
    );
}

function startWelcome({ replay = false, firstInteraction = false } = {}) {
    if (welcomeMuted) {
        setWelcomeStatus("An kashe sautin maraba. Kunna sauti kafin sauraro.");
        return;
    }
    if (!replay && !firstInteraction && welcomeAutoAttempted) return;
    if (!replay && welcomeActive) return;
    if (!replay) welcomeAutoAttempted = true;

    stopWelcomePlayback();
    const playbackId = welcomePlaybackId;
    const voice = findHausaVoice();
    if (voice && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window) {
        const utterance = new SpeechSynthesisUtterance(welcomeMessage);
        utterance.lang = voice.lang;
        utterance.voice = voice;
        utterance.rate = 0.92;
        utterance.onstart = () => {
            if (playbackId !== welcomePlaybackId || welcomeMuted) return;
            welcomeRequestPending = false;
            welcomeActive = true;
            welcomeHasPlayed = true;
            setWelcomeStatus(`Ana maraba da kai da murya ${voice.name} ta Hausa.`);
        };
        utterance.onend = () => {
            if (playbackId !== welcomePlaybackId || welcomeMuted) return;
            welcomeRequestPending = false;
            welcomeActive = false;
            setWelcomeStatus("An gama muryar maraba. Za ka iya sake sauraro.");
        };
        utterance.onerror = (event) => {
            if (playbackId !== welcomePlaybackId || welcomeMuted ||
                event.error === "canceled" || event.error === "interrupted") return;
            welcomeRequestPending = false;
            welcomeActive = false;
            playRecordedWelcome(playbackId);
        };
        try {
            welcomeRequestPending = true;
            window.speechSynthesis.speak(utterance);
            return;
        } catch {
            welcomeRequestPending = false;
            playRecordedWelcome(playbackId);
            return;
        }
    }
    playRecordedWelcome(playbackId);
}

function removeWelcomeInteractionListeners() {
    if (!welcomeFirstInteractionHandler) return;
    document.removeEventListener("pointerdown", welcomeFirstInteractionHandler);
    document.removeEventListener("keydown", welcomeFirstInteractionHandler);
    welcomeFirstInteractionHandler = null;
}

welcomeFirstInteractionHandler = () => {
    removeWelcomeInteractionListeners();
    if (!welcomeMuted && !welcomeActive && !welcomeHasPlayed && !welcomeRequestPending) {
        startWelcome({ firstInteraction: true });
    }
};
document.addEventListener("pointerdown", welcomeFirstInteractionHandler);
document.addEventListener("keydown", welcomeFirstInteractionHandler);

if ("speechSynthesis" in window) {
    window.speechSynthesis.addEventListener("voiceschanged", () => {
        if (!welcomeMuted && !welcomeHasPlayed && !welcomeRequestPending && findHausaVoice()) {
            startWelcome({ firstInteraction: true });
        }
    });
}

welcomeRecording.addEventListener("ended", () => {
    welcomeActive = false;
    setWelcomeStatus("An gama muryar maraba. Za ka iya sake sauraro.");
});
welcomeRecording.addEventListener("error", () => {
    if (welcomeMuted || welcomeActive) return;
    setWelcomeStatus(
        "Ba a samu muryar Hausa ba. Domin ƙara ingantaccen rikodi, saka hausa-welcome.mp3 a babban fayil ɗin assets.",
        true
    );
});

function updateWelcomeRecordingSource() {
    if (window.hfServerUrl()) {
        welcomeRecording.src = window.hfApiUrl("/assets/hausa-welcome.mp3");
    }
}

replayWelcomeButton.addEventListener("click", () => startWelcome({ replay: true }));
toggleWelcomeMuteButton.addEventListener("click", () => {
    welcomeMuted = !welcomeMuted;
    updateWelcomeMuteControl();
    try {
        localStorage.setItem("hf-welcome-muted", String(welcomeMuted));
    } catch {
        setWelcomeStatus("An canja sauti amma browser bai iya adana zaɓin ba.", true);
    }
    if (welcomeMuted) {
        stopWelcomePlayback();
        setWelcomeStatus("An kashe sautin maraba.");
    } else {
        setWelcomeStatus("An kunna sauti. Danna Saurari maraba domin sake sauraro.");
    }
});
updateWelcomeMuteControl();
updateWelcomeRecordingSource();
window.addEventListener("hf:server-config-changed", () => {
    updateWelcomeRecordingSource();
    void loadMovies();
    void loadMerlinEpisodes();
});
if (welcomeMuted) {
    setWelcomeStatus("An kashe sautin maraba. Za ka iya kunna shi a kowane lokaci.");
} else {
    startWelcome();
}

loadMovies();
loadMerlinEpisodes();

// HFF SIX-SCREEN NAVIGATION
(() => {
    const main = document.querySelector("main");
    if (!main || document.querySelector("[data-app-screen]")) return;

    const screens = {
        home: ["#home", ".promo-section"],
        movies: ["#movieDetailSection", "#movies", "#history", "#merlinCollection"],
        search: [".search-section", "#identify"],
        community: ["#accountArea", "#community", "#create-post", "#chat", "#notifications", "#profile"],
        mohammad: ["#mohammad"],
        settings: ["#serverSettings"]
    };

    const labels = {
        home: "Gida",
        movies: "Movies",
        search: "Search",
        community: "Community",
        mohammad: "Mohammad AI",
        settings: "Settings"
    };

    const icons = {
        home: "⌂",
        movies: "▣",
        search: "⌕",
        community: "◉",
        mohammad: "✦",
        settings: "⚙"
    };

    const wrappers = {};

    Object.entries(screens).forEach(([name, selectors]) => {
        const wrapper = document.createElement("div");
        wrapper.className = "app-screen";
        wrapper.dataset.appScreen = name;
        wrapper.setAttribute("aria-label", labels[name]);
        wrappers[name] = wrapper;
        main.appendChild(wrapper);

        selectors.forEach(selector => {
            const element = document.querySelector(selector);
            if (element) wrapper.appendChild(element);
        });
    });

    const settings = wrappers.settings;
    const settingsHeading = document.createElement("div");
    settingsHeading.className = "section-heading";
    settingsHeading.innerHTML =
        "<div><p class='eyebrow'>APP SETTINGS</p><h2>Saitunan App</h2></div>" +
        "<p>Saita haɗin server na HAUSA FILM FINDER AI.</p>";
    settings.prepend(settingsHeading);

    const headerNav = document.querySelector(".site-header nav");
    const bottomNav = document.querySelector(".bottom-nav");

    function buildNavigation(nav, isBottom) {
        if (!nav) return;

        nav.innerHTML = "";

        Object.entries(labels).forEach(([name, label]) => {
            const link = document.createElement("a");
            link.href = "#" + name;
            link.dataset.screen = name;

            if (isBottom) {
                link.setAttribute("aria-label", label);
                link.innerHTML =
                    "<span aria-hidden='true'>" + icons[name] + "</span>" +
                    "<span>" + label + "</span>";
            } else {
                link.textContent = label;
            }

            nav.appendChild(link);
        });
    }

    buildNavigation(headerNav, false);
    buildNavigation(bottomNav, true);

    const accountLink = document.getElementById("headerAccountLink");
    if (accountLink) {
        accountLink.href = "#community";
        accountLink.textContent = "Asusu";
    }

    const serverSummary = document.querySelector("#serverSettings summary");
    if (serverSummary) serverSummary.textContent = "Haɗin Server";

    const screenAliases = {
        accountArea: "community",
        community: "community",
        "create-post": "community",
        chat: "community",
        notifications: "community",
        profile: "community",
        history: "movies",
        merlinCollection: "movies",
        movieDetailSection: "movies",
        identify: "search",
        "search-section": "search",
        serverSettings: "settings"
    };

    function screenFromHash(hash) {
        const id = (hash || "").replace(/^#/, "");
        if (labels[id]) return id;
        if (screenAliases[id]) return screenAliases[id];

        const target = document.getElementById(id);
        const wrapper = target && target.closest("[data-app-screen]");
        return wrapper ? wrapper.dataset.appScreen : "home";
    }

    function activateScreen(name, targetId, updateUrl) {
        if (!wrappers[name]) name = "home";

        Object.entries(wrappers).forEach(([screenName, wrapper]) => {
            wrapper.hidden = screenName !== name;
        });

        document.querySelectorAll("[data-screen]").forEach(link => {
            const active = link.dataset.screen === name;
            link.classList.toggle("active", active);

            if (active) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
        });

        if (updateUrl) {
            const newHash = targetId || name;
            if (location.hash !== "#" + newHash) {
                history.pushState(null, "", "#" + newHash);
            }
        }

        const target = targetId && document.getElementById(targetId);
        if (target && target !== wrappers[name] && !target.hidden) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }
    }

    document.addEventListener("click", event => {
        const link = event.target.closest("a[href^='#']");
        if (!link) return;

        const id = link.getAttribute("href").slice(1);
        if (!id) return;

        const name = screenFromHash(id);
        if (!wrappers[name]) return;

        event.preventDefault();
        activateScreen(name, id, true);
    });

    window.addEventListener("popstate", () => {
        activateScreen(screenFromHash(location.hash), null, false);
    });

    window.addEventListener("hashchange", () => {
        activateScreen(screenFromHash(location.hash), null, false);
    });

    activateScreen(screenFromHash(location.hash), null, false);
})();
