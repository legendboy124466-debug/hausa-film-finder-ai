const SOCIAL_API_TIMEOUT_MS = 30000;
const SOCIAL_API_MAX_RETRIES = 3;

async function socialFetchWithRetry(input, init) {
    let lastError;
    for (let attempt = 0; attempt <= SOCIAL_API_MAX_RETRIES; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SOCIAL_API_TIMEOUT_MS);
        try {
            const response = await fetch(input, { ...init, signal: controller.signal });
            clearTimeout(timeout);
            return response;
        } catch (error) {
            clearTimeout(timeout);
            lastError = error;
            if (error.name === "AbortError") {
                throw new Error("Server Æ™ara ta É—auki lokaci (timeout). Gwada sake aikawa.");
            }
            if (attempt < SOCIAL_API_MAX_RETRIES && error instanceof TypeError) {
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
    throw lastError;
}

const authForms = document.getElementById("authForms");
const sessionInfo = document.getElementById("sessionInfo");
const sessionGreeting = document.getElementById("sessionGreeting");
const headerAccountLink = document.getElementById("headerAccountLink");
const socialSections = [...document.querySelectorAll("[data-auth-section]")];
const authNavLinks = [...document.querySelectorAll("[data-auth-nav]")];
const feedPosts = document.getElementById("feedPosts");
const peopleResults = document.getElementById("peopleResults");
const conversationList = document.getElementById("conversationList");
const groupList = document.getElementById("groupList");
const socialChatMessages = document.getElementById("socialChatMessages");
const chatHeader = document.getElementById("chatHeader");
const messageForm = document.getElementById("messageForm");
const messageStatus = document.getElementById("messageStatus");
const profileStatus = document.getElementById("profileStatus");
const favoriteMovies = document.getElementById("favoriteMovies");
const reviewDialog = document.getElementById("reviewDialog");
let currentUser = null;
let currentMovies = [];
let currentScope = "discover";
let activeChat = null;
let replyToId = null;
let favoriteIds = new Set();
let refreshTimer = null;
let mediaRecorder = null;
let recordingStream = null;

async function socialApi(url, options = {}) {
    console.log("[HF] socialApi call:", url, options);
    const response = await socialFetchWithRetry(window.hfApiUrl(url), { credentials: "include", ...options });
    const payload = await response.json().catch(() => ({}));
    console.log("[HF] socialApi response:", response.status, payload);
    if (!response.ok) throw new Error(payload.error || `BuÆ™atar ta gaza (${response.status}).`);
    return payload;
}

function setStatus(element, text, isError = false) {
    element.textContent = text || "";
    element.classList.toggle("error", Boolean(text && isError));
}

function safeMediaUrl(url) {
    if (typeof url !== "string" || !url.startsWith("/api/social/media/")) return "";
    return window.hfApiUrl(url);
}

function makeButton(label, action, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (action) button.dataset.action = action;
    if (className) button.className = className;
    return button;
}

function switchAuthentication(user) {
    console.log("[HF] switchAuthentication called with:", user);
    currentUser = user;
    const isAuthenticated = Boolean(user);
    authForms.hidden = isAuthenticated;
    sessionInfo.hidden = !isAuthenticated;
    socialSections.forEach((section) => { section.hidden = !isAuthenticated; });
    authNavLinks.forEach((link) => { link.hidden = !isAuthenticated; });
    if (user) {
        sessionGreeting.textContent = `Sannu, ${user.fullName} (@${user.username})`;
        headerAccountLink.textContent = `@${user.username}`;
        headerAccountLink.href = "#profile";
    } else {
        headerAccountLink.textContent = "Shiga";
        headerAccountLink.href = "#accountArea";
    }
    window.dispatchEvent(new CustomEvent("hf:auth", { detail: { authenticated: isAuthenticated } }));
    if (isAuthenticated) {
        void refreshSocialData();
    } else {
        clearInterval(refreshTimer);
        activeChat = null;
        socialChatMessages.replaceChildren();
        feedPosts.replaceChildren();
    }
}

async function loadSession() {
    console.log("[HF] loadSession called");
    try {
        const data = await socialApi("/api/social/me");
        console.log("[HF] loadSession response:", data);
        switchAuthentication(data.user);
    } catch (error) {
        console.error("[HF] loadSession error:", error);
        setStatus(document.getElementById("loginStatus"), error.message, true);
    }
}

function renderMovieOptions(movies) {
    currentMovies = Array.isArray(movies) ? movies : [];
    for (const select of document.querySelectorAll('select[name="movieId"]')) {
        const previous = select.value;
        select.replaceChildren(new Option("Ba zan haÉ—a fim ba", ""));
        for (const movie of currentMovies) {
            const option = new Option(
                `${movie.hausaTitle ? `${movie.hausaTitle} Â· ` : ""}${movie.title}`,
                movie.id
            );
            select.appendChild(option);
        }
        if ([...select.options].some((option) => option.value === previous)) select.value = previous;
    }
}

async function loadFavoriteIds() {
    if (!currentUser) return;
    const data = await socialApi("/api/social/favorites");
    favoriteIds = new Set(data.movies.map((movie) => movie.id));
    for (const button of document.querySelectorAll("[data-favorite-movie]")) {
        const id = button.dataset.favoriteMovie;
        button.textContent = favoriteIds.has(id) ? "â™¥ An ajiye" : "â™¡ Ajiye a favorites";
        button.setAttribute("aria-pressed", String(favoriteIds.has(id)));
    }
    renderFavorites(data.movies);
}

async function loadMoviesForSocial() {
    try {
        const data = await socialApi("/api/movies");
        if (!window.hfCurrentMovies) renderMovieOptions(data.movies);
    } catch (error) {
        setStatus(document.getElementById("postStatus"), `Ba a samu kundin fim ba: ${error.message}`, true);
    }
}

async function refreshSocialData() {
    if (!currentUser) return;
    try {
        await Promise.all([
            loadFeed(currentScope),
            loadCurrentProfile(),
            loadFavoriteIds(),
            loadStudios(),
            loadConversations(),
            loadGroups(),
            loadBlockedUsers()
        ]);
    } catch (error) {
        setStatus(profileStatus, `An kasa sabunta bayanan al'umma: ${error.message}`, true);
    }
    clearInterval(refreshTimer);
    refreshTimer = window.setInterval(() => {
        if (!currentUser) return;
        void loadNotifications();
        void loadConversations();
        if (activeChat) void loadChatMessages();
    }, 15000);
}

function userPhoto(user) {
    return safeMediaUrl(user.photoUrl) ||
        (user.photoMediaId ? `/api/social/media/${encodeURIComponent(user.photoMediaId)}` : "");
}

function renderPerson(container, user, options = {}) {
    const card = document.createElement("article");
    card.className = "person-card";
    const info = document.createElement("div");
    info.className = "person-info";
    const photo = userPhoto(user);
    if (photo) {
        const image = document.createElement("img");
        image.src = window.hfApiUrl(photo);
        image.alt = "";
        image.loading = "lazy";
        info.appendChild(image);
    }
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = user.fullName || user.username;
    const handle = document.createElement("p");
    handle.textContent = `@${user.username}${user.isPrivate ? " Â· Mai zaman kansa" : ""}`;
    copy.append(name, handle);
    if (options.includeBio && user.bio) {
        const bio = document.createElement("p");
        bio.textContent = user.bio;
        copy.appendChild(bio);
    }
    info.appendChild(copy);
    const controls = document.createElement("div");
    controls.className = "person-controls";
    const view = makeButton("Duba profile", "view-user", "secondary-button");
    view.dataset.username = user.username;
    controls.appendChild(view);
    if (user.id !== currentUser?.id && options.follow !== false) {
        const followed = Boolean(user.isFollowing);
        const pending = Boolean(user.requestPending);
        const follow = makeButton(
            followed ? "Æ˜i bi" : pending ? "An aika buÆ™ata" : "Bi",
            followed ? "unfollow-user" : "follow-user",
            followed || pending ? "secondary-button" : ""
        );
        follow.dataset.userId = user.id;
        follow.disabled = pending;
        controls.appendChild(follow);
    }
    if (options.message) {
        const message = makeButton("Aika saÆ™o", "message-user", "secondary-button");
        message.dataset.userId = user.id;
        controls.appendChild(message);
    }
    if (options.manage) {
        const block = makeButton("Toshe", "block-user", "secondary-button");
        block.dataset.userId = user.id;
        controls.appendChild(block);
        const report = makeButton("Kai rahoto", "report-user", "secondary-button");
        report.dataset.userId = user.id;
        controls.appendChild(report);
    }
    card.append(info, controls);
    container.appendChild(card);
    return card;
}

async function searchPeople(query, container, options = {}) {
    container.replaceChildren();
    const data = await socialApi(`/api/social/users/search?q=${encodeURIComponent(query || "")}`);
    if (!data.users.length) {
        container.textContent = "Ba a sami mai amfani ba.";
        return;
    }
    for (const user of data.users) renderPerson(container, user, options);
}

async function openUserProfile(username) {
    try {
        const data = await socialApi(`/api/social/users/${encodeURIComponent(username)}`);
        const profile = data.profile;
        const container = document.getElementById("publicProfile");
        container.replaceChildren();
        const card = document.createElement("article");
        card.className = "profile-card";
        const photo = userPhoto(profile);
        if (photo) {
            const image = document.createElement("img");
            image.className = "profile-avatar";
            image.src = window.hfApiUrl(photo);
            image.alt = "";
            card.appendChild(image);
        }
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = `${profile.fullName} Â· @${profile.username}`;
        const bio = document.createElement("p");
        bio.textContent = profile.bio || (profile.isPrivate && !profile.isFollowing
            ? "Wannan profile na zaman kansa ne."
            : "");
        const counts = document.createElement("p");
        counts.textContent = `${profile.followersCount} masu bi Â· ${profile.followingCount} waÉ—anda yake bi`;
        content.append(title, bio, counts);
        card.appendChild(content);
        const controls = document.createElement("div");
        controls.className = "person-controls";
        if (!profile.isFollowing && profile.id !== currentUser.id && !profile.requestPending) {
            const follow = makeButton("Bi", "follow-user", "secondary-button");
            follow.dataset.userId = profile.id;
            controls.appendChild(follow);
        } else if (profile.requestPending) {
            controls.appendChild(document.createTextNode("An aika buÆ™atar bin asusu."));
        } else if (profile.isFollowing) {
            const unfollow = makeButton("Æ˜i bi", "unfollow-user", "secondary-button");
            unfollow.dataset.userId = profile.id;
            controls.appendChild(unfollow);
        }
        if (profile.id !== currentUser.id) {
            const message = makeButton("Aika saÆ™o", "message-user", "secondary-button");
            message.dataset.userId = profile.id;
            const block = makeButton("Toshe", "block-user", "secondary-button");
            block.dataset.userId = profile.id;
            const report = makeButton("Kai rahoto", "report-user", "secondary-button");
            report.dataset.userId = profile.id;
            controls.append(message, block, report);
        }
        card.appendChild(controls);
        container.appendChild(card);
    } catch (error) {
        setStatus(profileStatus, error.message, true);
    }
}

async function loadCurrentProfile() {
    const profile = currentUser;
    const form = document.getElementById("profileForm");
    form.elements.fullName.value = profile.fullName || "";
    form.elements.bio.value = profile.bio || "";
    form.elements.isPrivate.checked = Boolean(profile.isPrivate);
    form.elements.messagePolicy.value = profile.messagePolicy || "everyone";
    const card = document.getElementById("profileCard");
    card.replaceChildren();
    const photo = userPhoto(profile);
    if (photo) {
        const image = document.createElement("img");
        image.className = "profile-avatar";
        image.src = window.hfApiUrl(photo);
        image.alt = "Hoton profile";
        card.appendChild(image);
    }
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${profile.fullName} (@${profile.username})`;
    const bio = document.createElement("p");
    bio.textContent = profile.bio || "Ba a saka bayani ba tukuna.";
    text.append(name, bio);
    card.appendChild(text);
    const counts = document.getElementById("profileCounts");
    counts.replaceChildren();
    for (const [label, count, action] of [
        ["Masu bi", profile.followersCount, "followers"],
        ["WaÉ—anda nake bi", profile.followingCount, "following"]
    ]) {
        const button = makeButton(`${count} ${label}`, action, "secondary-button");
        counts.appendChild(button);
    }
}

async function loadFeed(scope = currentScope) {
    currentScope = scope;
    const data = await socialApi(`/api/social/feed?scope=${encodeURIComponent(scope)}`);
    feedPosts.replaceChildren();
    for (const post of data.posts) renderPost(post);
    if (!data.posts.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = scope === "following"
            ? "Babu post daga mutanen da kake bi tukuna."
            : "Babu post a al'umma tukuna.";
        feedPosts.appendChild(empty);
    }
}

function appendMovieShare(parent, movieId, title, posterUrl, rating) {
    const section = document.createElement("div");
    section.className = "post-movie";
    if (posterUrl) {
        const image = document.createElement("img");
        image.src = window.hfApiUrl(posterUrl);
        image.alt = `Poster: ${title || "fim"}`;
        image.loading = "lazy";
        section.appendChild(image);
    }
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = title || "Fim daga kundin";
    text.appendChild(name);
    if (rating) {
        const score = document.createElement("p");
        score.textContent = `Æ˜ima: ${rating}/5`;
        text.appendChild(score);
    }
    if (movieId) {
        const review = makeButton("Rubuta review", "review-movie", "secondary-button");
        review.dataset.movieId = movieId;
        text.appendChild(review);
    }
    section.appendChild(text);
    parent.appendChild(section);
}

function renderPost(post) {
    const card = document.createElement("article");
    card.className = "post-card";
    card.dataset.postId = post.id;
    const heading = document.createElement("div");
    heading.className = "post-heading";
    const photo = safeMediaUrl(post.author.photoUrl);
    if (photo) {
        const image = document.createElement("img");
        image.src = window.hfApiUrl(photo);
        image.alt = "";
        image.loading = "lazy";
        heading.appendChild(image);
    }
    const author = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${post.author.fullName} Â· @${post.author.username}`;
    const date = document.createElement("p");
    date.textContent = new Date(post.createdAt).toLocaleString("ha");
    author.append(name, date);
    heading.appendChild(author);
    card.appendChild(heading);
    if (post.content) {
        const content = document.createElement("p");
        content.className = "post-content";
        content.textContent = post.content;
        card.appendChild(content);
    }
    if (post.movieId) appendMovieShare(card, post.movieId, post.movieTitle, post.posterUrl, post.rating);
    if (post.authorizedLink) {
        const link = document.createElement("a");
        link.href = post.authorizedLink;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "BuÉ—e hanyar fim da aka amince da ita";
        card.appendChild(link);
    }
    if (post.attachmentUrl) {
        const fileUrl = safeMediaUrl(post.attachmentUrl);
        if (fileUrl) {
            const mimeType = post.attachmentMimeType || "";
            const file = document.createElement(mimeType.startsWith("audio/") ? "audio"
                : mimeType === "application/pdf" ? "a" : "img");
            file.className = "post-attachment";
            if (file.tagName === "A") {
                file.href = window.hfApiUrl(fileUrl);
                file.textContent = "BuÉ—e PDF";
                file.target = "_blank";
                file.rel = "noopener noreferrer";
            } else {
                if (file.tagName === "AUDIO") file.controls = true;
                else file.alt = "Fayil da aka haÉ—a";
                file.src = window.hfApiUrl(fileUrl);
            }
            card.appendChild(file);
        }
    }
    if (post.sharedPost) {
        const shared = document.createElement("div");
        shared.className = "comment-card";
        shared.textContent = `An sake rabawa daga @${post.sharedPost.username}: ${post.sharedPost.content || post.sharedPost.movieTitle || "Post"}`;
        card.appendChild(shared);
    }
    const actions = document.createElement("div");
    actions.className = "post-actions";
    const like = makeButton(`${post.likedByMe ? "â™¥" : "â™¡"} ${post.likesCount}`, "like-post");
    like.dataset.postId = post.id;
    like.setAttribute("aria-pressed", String(post.likedByMe));
    const comments = makeButton(`Sharhi ${post.commentsCount}`, "toggle-comments", "secondary-button");
    comments.dataset.postId = post.id;
    const share = makeButton("Sake rabawa", "share-post", "secondary-button");
    share.dataset.postId = post.id;
    const report = makeButton("Kai rahoto", "report-post", "secondary-button");
    report.dataset.postId = post.id;
    actions.append(like, comments, share, report);
    card.appendChild(actions);
    const commentArea = document.createElement("div");
    commentArea.className = "comments";
    commentArea.dataset.commentsFor = post.id;
    commentArea.hidden = true;
    card.appendChild(commentArea);
    feedPosts.appendChild(card);
}

async function loadComments(postId, area) {
    const data = await socialApi(`/api/social/posts/${encodeURIComponent(postId)}/comments`);
    area.replaceChildren();
    for (const comment of data.comments) {
        const item = document.createElement("article");
        item.className = "comment-card";
        const author = document.createElement("strong");
        author.textContent = `${comment.fullName} Â· @${comment.username}`;
        const text = document.createElement("p");
        text.textContent = comment.content;
        item.append(author, text);
        if (comment.parentId) {
            const reply = document.createElement("small");
            reply.textContent = "Amsa ce ga wani sharhi.";
            item.appendChild(reply);
        }
        const replyButton = makeButton("Amsa", "reply-comment", "secondary-button");
        replyButton.dataset.commentId = comment.id;
        item.appendChild(replyButton);
        area.appendChild(item);
    }
    const form = document.createElement("form");
    form.className = "comment-form";
    form.dataset.postId = postId;
    form.innerHTML = "";
    const input = document.createElement("input");
    input.name = "content";
    input.maxLength = 1000;
    input.placeholder = "Rubuta sharhi...";
    input.required = true;
    const button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Aika";
    form.append(input, button);
    area.appendChild(form);
}

function reportPrompt(targetType, targetId) {
    const reason = window.prompt("Me ya sa kake kai wannan rahoto? (haruffa 1 zuwa 100)");
    if (!reason?.trim()) return;
    void socialApi("/api/social/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetType, targetId, reason: reason.trim() })
    }).then(() => window.alert("An aika rahoton ga masu gudanarwa."))
        .catch((error) => window.alert(error.message));
}

async function loadFollowRequests() {
    const data = await socialApi("/api/social/follow-requests");
    for (const user of data.users) {
        const existing = document.querySelector(`[data-follow-request="${CSS.escape(user.id)}"]`);
        if (existing) continue;
        const card = document.createElement("article");
        card.className = "notification-card";
        card.dataset.followRequest = user.id;
        const text = document.createElement("p");
        text.textContent = `${user.fullName} (@${user.username}) na son bin ka.`;
        const controls = document.createElement("div");
        controls.className = "message-actions";
        const accept = makeButton("Amince", "accept-follow", "secondary-button");
        accept.dataset.userId = user.id;
        const reject = makeButton("Æ˜i", "reject-follow", "secondary-button");
        reject.dataset.userId = user.id;
        controls.append(accept, reject);
        card.append(text, controls);
        document.getElementById("notificationList").prepend(card);
    }
}

async function loadNotifications() {
    const data = await socialApi("/api/social/notifications");
    const list = document.getElementById("notificationList");
    list.replaceChildren();
    for (const item of data.notifications) {
        const card = document.createElement("article");
        card.className = `notification-card${item.readAt ? "" : " unread"}`;
        const text = document.createElement("div");
        const actor = item.actorFullName
            ? `${item.actorFullName} (@${item.actorUsername})`
            : "Studio";
        const messages = {
            new_follower: `${actor} ya fara bin ka.`,
            follow_request: `${actor} na son bin asusunka.`
                ,
            follow_accepted: `${actor} ya amince da buÆ™atar bin asusu.`,
            post_like: `${actor} ya so post É—inka.`,
            post_comment: `${actor} ya yi sharhi a post É—inka.`,
            comment_reply: `${actor} ya amsa sharhinka.`,
            private_message: `${actor} ya aiko maka da saÆ™o.`,
            private_message_request: `${actor} ya aiko da buÆ™atar saÆ™o.`,
            group_message: `${actor} ya rubuta a Æ™ungiyar da kake ciki.`,
            studio_movie: `${item.payload.studio || actor} ya fitar da fim mai suna "${item.payload.title || ""}".`
        };
        const message = document.createElement("p");
        message.textContent = messages[item.type] || "Akwai sabon labari a asusunka.";
        const date = document.createElement("small");
        date.textContent = new Date(item.createdAt).toLocaleString("ha");
        text.append(message, date);
        const open = makeButton("Duba", "open-notification", "secondary-button");
        open.dataset.type = item.type;
        open.dataset.entityId = item.entityId || "";
        card.append(text, open);
        list.appendChild(card);
    }
    const mark = document.getElementById("markNotificationsRead");
    mark.textContent = data.unreadCount ? `Alama an karanta (${data.unreadCount})` : "An karanta duka";
    await loadFollowRequests();
}

function renderFavorites(movies) {
    favoriteMovies.replaceChildren();
    if (!movies.length) {
        favoriteMovies.textContent = "Ba ka ajiye fim a favoriti ba tukuna.";
        return;
    }
    for (const movie of movies) {
        const item = document.createElement("article");
        item.className = "person-card";
        const title = document.createElement("strong");
        title.textContent = `${movie.hausaTitle ? `${movie.hausaTitle} Â· ` : ""}${movie.title}`;
        const remove = makeButton("Cire", "remove-favorite", "secondary-button");
        remove.dataset.movieId = movie.id;
        item.append(title, remove);
        favoriteMovies.appendChild(item);
    }
}

async function loadStudios() {
    const data = await socialApi("/api/social/studios");
    const list = document.getElementById("studioList");
    list.replaceChildren();
    for (const studio of data.studios) {
        const card = document.createElement("article");
        card.className = "person-card";
        const name = document.createElement("strong");
        name.textContent = `${studio.name} Â· ${studio.followersCount} masu bi`;
        const button = makeButton(
            studio.isFollowing ? "Æ˜i bi" : "Bi studio",
            studio.isFollowing ? "unfollow-studio" : "follow-studio",
            "secondary-button"
        );
        button.dataset.studioId = studio.id;
        card.append(name, button);
        list.appendChild(card);
    }
}

async function loadBlockedUsers() {
    const data = await socialApi("/api/social/blocks");
    const list = document.getElementById("blockedUsers");
    list.replaceChildren();
    if (!data.users.length) {
        list.textContent = "Ba ka toshe wani asusu ba.";
        return;
    }
    for (const user of data.users) {
        const card = document.createElement("article");
        card.className = "person-card";
        const text = document.createElement("strong");
        text.textContent = `${user.fullName} (@${user.username})`;
        const unblock = makeButton("Cire block", "unblock-user", "secondary-button");
        unblock.dataset.userId = user.id;
        card.append(text, unblock);
        list.appendChild(card);
    }
}

async function loadConnections(which) {
    const data = await socialApi(`/api/social/users/${encodeURIComponent(currentUser.username)}/${which}`);
    const list = document.getElementById("connectionList");
    list.replaceChildren();
    if (!data.users.length) list.textContent = "Jerin babu komai tukuna.";
    for (const user of data.users) renderPerson(list, user, { message: true });
}

function renderConversations(conversations) {
    conversationList.replaceChildren();
    if (!conversations.length) {
        conversationList.textContent = "Babu tattaunawa tukuna.";
        return;
    }
    for (const conversation of conversations) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.openConversation = conversation.conversationId;
        button.dataset.peerId = conversation.peer.id;
        button.dataset.requestTargetId = conversation.requestTargetId || "";
        button.setAttribute("aria-current", String(activeChat?.id === conversation.conversationId));
        button.textContent = `${conversation.peer.fullName} (@${conversation.peer.username})${conversation.requestStatus === "pending" ? " Â· BuÆ™ata" : ""}${conversation.lastMessage ? ` â€” ${conversation.lastMessage.slice(0, 40)}` : ""}`;
        conversationList.appendChild(button);
    }
}

async function loadConversations() {
    const data = await socialApi("/api/social/conversations");
    renderConversations(data.conversations);
}

async function loadGroups() {
    const data = await socialApi("/api/social/groups");
    groupList.replaceChildren();
    for (const group of data.groups) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.groupId = group.id;
        button.dataset.groupName = group.name;
        button.dataset.isMember = String(group.isMember);
        button.textContent = `${group.name} Â· ${group.membersCount} mambobi${group.isMember ? "" : " Â· Shiga"}`;
        groupList.appendChild(button);
    }
    if (!data.groups.length) groupList.textContent = "Babu Æ™ungiya tukuna.";
}

async function openConversation(peerId, conversationId = null, requestTargetId = null) {
    try {
        if (!conversationId) {
            const data = await socialApi(`/api/social/conversations/${encodeURIComponent(peerId)}`, {
                method: "POST"
            });
            conversationId = data.conversationId;
            if (data.requestPending) requestTargetId = peerId;
        }
        activeChat = { type: "direct", id: conversationId, peerId, requestTargetId };
        await loadChatMessages();
        await loadConversations();
    } catch (error) {
        setStatus(messageStatus, error.message, true);
    }
}

async function openGroup(groupId, name) {
    activeChat = { type: "group", id: groupId, name };
    await loadChatMessages();
}

function renderChatControls(data) {
    chatHeader.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = activeChat.type === "direct"
        ? `Tattaunawa da @${activeChat.peerUsername || "mai amfani"}`
        : `Æ˜ungiya: ${activeChat.name}`;
    chatHeader.appendChild(title);
    if (activeChat.type === "direct") {
        if (data.requestStatus === "pending" && data.requestTargetId === currentUser.id) {
            const accept = makeButton("Amince da buÆ™atar", "accept-message-request");
            const reject = makeButton("Æ˜i buÆ™atar", "reject-message-request", "secondary-button");
            chatHeader.append(accept, reject);
            messageForm.hidden = true;
        } else if (data.requestStatus === "pending" && data.messages.length > 0) {
            const notice = document.createElement("p");
            notice.textContent = "An aika buÆ™atar saÆ™o É—aya. Jira amincewar mai karÉ“a.";
            chatHeader.appendChild(notice);
            messageForm.hidden = true;
        } else {
            messageForm.hidden = false;
        }
        const block = makeButton("Toshe", "block-chat-user", "secondary-button");
        block.dataset.userId = data.peerId;
        const report = makeButton("Kai rahoto", "report-chat-user", "secondary-button");
        report.dataset.userId = data.peerId;
        chatHeader.append(block, report);
    } else {
        messageForm.hidden = false;
    }
    const cancelReply = document.getElementById("cancelReplyButton");
    cancelReply.hidden = !replyToId;
}

function renderChatMessage(message, type) {
    const bubble = document.createElement("article");
    bubble.className = `message-bubble${message.senderId === currentUser.id ? " mine" : ""}`;
    bubble.dataset.messageId = message.id;
    if (message.replyContent) {
        const quote = document.createElement("small");
        quote.className = "message-meta";
        quote.textContent = `Amsa: ${message.replyContent}`;
        bubble.appendChild(quote);
    }
    if (message.deletedAt || message.removedAt) {
        const deleted = document.createElement("p");
        deleted.textContent = "An goge wannan saÆ™o.";
        bubble.appendChild(deleted);
    } else if (message.content) {
        const content = document.createElement("p");
        content.textContent = message.content;
        bubble.appendChild(content);
    }
    if (message.movieId) appendMovieShare(bubble, message.movieId, message.movieTitle, message.posterUrl);
    if (message.authorizedLink) {
        const link = document.createElement("a");
        link.href = message.authorizedLink;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "BuÉ—e hanyar fim";
        bubble.appendChild(link);
    }
    if (message.attachmentUrl) {
        const url = safeMediaUrl(message.attachmentUrl);
        if (url) {
            const mimeType = message.attachmentMimeType || "";
            const media = document.createElement(mimeType === "application/pdf" ? "a"
                : mimeType.startsWith("audio/") ? "audio" : "img");
            media.className = "post-attachment";
            if (media.tagName === "A") {
                media.href = window.hfApiUrl(url);
                media.textContent = "BuÉ—e PDF";
                media.target = "_blank";
                media.rel = "noopener noreferrer";
            } else {
                media.src = window.hfApiUrl(url);
                if (media.tagName === "AUDIO") media.controls = true;
                else media.alt = "Fayil da aka aika";
            }
            bubble.appendChild(media);
        }
    }
    if (message.senderId === currentUser.id && type === "direct") {
        const status = document.createElement("small");
        status.className = "message-meta";
        status.textContent = message.readAt ? "An karanta" : message.deliveredAt ? "Ya isa" : "An aika";
        bubble.appendChild(status);
    }
    if (message.reactions?.length) {
        const row = document.createElement("small");
        row.className = "message-meta";
        row.textContent = message.reactions.map((reaction) => `${reaction.reaction} ${reaction.count}`).join(" Â· ");
        bubble.appendChild(row);
    }
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const reply = makeButton("Amsa", "reply-message", "secondary-button");
    reply.dataset.messageId = message.id;
    actions.appendChild(reply);
    const react = makeButton("ðŸ‘", type === "direct" ? "react-message" : "react-group-message", "secondary-button");
    react.dataset.messageId = message.id;
    react.dataset.reaction = "ðŸ‘";
    actions.appendChild(react);
    const report = makeButton("Rahoto", "report-message", "secondary-button");
    report.dataset.messageId = message.id;
    report.dataset.targetType = type === "direct" ? "message" : "group";
    if (type !== "direct") report.dataset.targetId = activeChat.id;
    actions.appendChild(report);
    if (message.senderId === currentUser.id && type === "direct" && !message.deletedAt) {
        const remove = makeButton("Goge", "delete-message", "secondary-button");
        remove.dataset.messageId = message.id;
        actions.appendChild(remove);
    }
    bubble.appendChild(actions);
    socialChatMessages.appendChild(bubble);
}

async function loadChatMessages() {
    if (!activeChat || !currentUser) return;
    const route = activeChat.type === "direct"
        ? `/api/social/conversations/${encodeURIComponent(activeChat.id)}/messages`
        : `/api/social/groups/${encodeURIComponent(activeChat.id)}/messages`;
    try {
        const data = await socialApi(route);
        if (activeChat.type === "direct") {
            activeChat.peerId = data.peerId;
            activeChat.requestTargetId = data.requestTargetId;
            const peer = await socialApi(`/api/social/conversations`);
            const current = peer.conversations.find((conversation) => conversation.conversationId === activeChat.id);
            activeChat.peerUsername = current?.peer.username;
            if (current) activeChat.peerId = current.peer.id;
        }
        socialChatMessages.replaceChildren();
        renderChatControls(data);
        for (const message of data.messages) renderChatMessage(message, activeChat.type);
        socialChatMessages.scrollTop = socialChatMessages.scrollHeight;
        setStatus(messageStatus, "");
    } catch (error) {
        setStatus(messageStatus, error.message, true);
    }
}

async function toggleFavorite(movieId, button) {
    const isFavorite = favoriteIds.has(movieId);
    await socialApi(`/api/social/favorites/${encodeURIComponent(movieId)}`, {
        method: isFavorite ? "DELETE" : "POST"
    });
    if (isFavorite) favoriteIds.delete(movieId);
    else favoriteIds.add(movieId);
    button.textContent = isFavorite ? "â™¡ Ajiye a favorites" : "â™¥ An ajiye";
    button.setAttribute("aria-pressed", String(!isFavorite));
    await loadFavoriteIds();
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    console.log("[HF] Login form submitted");
    const form = event.currentTarget;
    const status = document.getElementById("loginStatus");
    setStatus(status, "Ana shiga...");
    try {
        const data = await socialApi("/api/social/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        console.log("[HF] Login response:", data);
        form.reset();
        switchAuthentication(data.user);
    } catch (error) {
        console.error("[HF] Login error:", error);
        setStatus(status, error.message, true);
    }
});

document.getElementById("registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("registerStatus");
    setStatus(status, "Ana Æ™irÆ™irar asusu...");
    try {
        const data = await socialApi("/api/social/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(form)))
        });
        form.reset();
        switchAuthentication(data.user);
    } catch (error) {
        setStatus(status, error.message, true);
    }
});

document.getElementById("logoutButton").addEventListener("click", async () => {
    console.log("[HF] Logout clicked");
    try {
        await socialApi("/api/social/logout", { method: "POST" });
        switchAuthentication(null);
    } catch (error) {
        console.error("[HF] Logout error:", error);
        setStatus(profileStatus, error.message, true);
    }
});

document.getElementById("peopleSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        await searchPeople(event.currentTarget.elements.q.value.trim(), peopleResults, {
            message: true,
            manage: true
        });
    } catch (error) {
        peopleResults.textContent = error.message;
    }
});

document.getElementById("chatSearchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = document.getElementById("chatPeopleResults");
    try {
        await searchPeople(event.currentTarget.elements.q.value.trim(), target, { follow: false, message: true });
    } catch (error) {
        target.textContent = error.message;
    }
});

peopleResults.addEventListener("click", (event) => { void handleSocialAction(event); });
document.getElementById("chatPeopleResults").addEventListener("click", (event) => { void handleSocialAction(event); });
document.getElementById("publicProfile").addEventListener("click", (event) => { void handleSocialAction(event); });
document.getElementById("profileCounts").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "followers" || action === "following") {
        try { await loadConnections(action); } catch (error) { setStatus(profileStatus, error.message, true); }
    }
});
document.getElementById("showFollowers").addEventListener("click", () => { void loadConnections("followers"); });
document.getElementById("showFollowing").addEventListener("click", () => { void loadConnections("following"); });

document.querySelectorAll("[data-feed-scope]").forEach((button) => {
    button.addEventListener("click", async () => {
        document.querySelectorAll("[data-feed-scope]").forEach((tab) =>
            tab.setAttribute("aria-pressed", String(tab === button)));
        try { await loadFeed(button.dataset.feedScope); } catch (error) { feedPosts.textContent = error.message; }
    });
});

document.getElementById("postForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(document.getElementById("postStatus"), "Ana wallafa post...");
    try {
        const data = new FormData(form);
        if (!form.elements.attachment.files.length) data.delete("attachment");
        await socialApi("/api/social/posts", { method: "POST", body: data });
        form.reset();
        setStatus(document.getElementById("postStatus"), "An wallafa post É—inka.");
        await loadFeed(currentScope);
        document.getElementById("community").scrollIntoView({ behavior: "smooth" });
    } catch (error) {
        setStatus(document.getElementById("postStatus"), error.message, true);
    } finally {
        button.disabled = false;
    }
});

feedPosts.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, postId } = button.dataset;
    try {
        if (action === "like-post") {
            await socialApi(`/api/social/posts/${encodeURIComponent(postId)}/like`, { method: "POST" });
            await loadFeed(currentScope);
        } else if (action === "toggle-comments") {
            const area = feedPosts.querySelector(`[data-comments-for="${CSS.escape(postId)}"]`);
            area.hidden = !area.hidden;
            if (!area.hidden) await loadComments(postId, area);
        } else if (action === "share-post") {
            const content = window.prompt("Æ˜ara saÆ™on rabawa (idan kana so):") || "";
            await socialApi(`/api/social/posts/${encodeURIComponent(postId)}/share`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content })
            });
            await loadFeed(currentScope);
        } else if (action === "report-post") {
            reportPrompt("post", postId);
        } else if (action === "review-movie") {
            openReview(button.dataset.movieId);
        } else if (action === "reply-comment") {
            const area = button.closest(".comments");
            const input = area.querySelector(".comment-form input");
            input.placeholder = "Amsa ga sharhin...";
            input.dataset.parentId = button.dataset.commentId;
            input.focus();
        }
    } catch (error) {
        window.alert(error.message);
    }
});

feedPosts.addEventListener("submit", async (event) => {
    const form = event.target.closest(".comment-form");
    if (!form) return;
    event.preventDefault();
    const input = form.elements.content;
    try {
        await socialApi(`/api/social/posts/${encodeURIComponent(form.dataset.postId)}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: input.value.trim(),
                parentId: input.dataset.parentId || null
            })
        });
        input.value = "";
        delete input.dataset.parentId;
        input.placeholder = "Rubuta sharhi...";
        await loadComments(form.dataset.postId, form.closest(".comments"));
        await loadFeed(currentScope);
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(profileStatus, "Ana ajiye saitunan...");
    try {
        const values = {
            fullName: form.elements.fullName.value.trim(),
            bio: form.elements.bio.value.trim(),
            isPrivate: form.elements.isPrivate.checked,
            messagePolicy: form.elements.messagePolicy.value
        };
        const data = await socialApi("/api/social/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(values)
        });
        currentUser = data.profile;
        if (form.elements.photo.files[0]) {
            const photoData = new FormData();
            photoData.append("photo", form.elements.photo.files[0]);
            await socialApi("/api/social/profile/photo", { method: "POST", body: photoData });
        }
        const me = await socialApi("/api/social/me");
        currentUser = me.user;
        await loadCurrentProfile();
        setStatus(profileStatus, "An sabunta profile É—inka.");
    } catch (error) {
        setStatus(profileStatus, error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById("favoriteMovies").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='remove-favorite']");
    if (!button) return;
    try {
        await socialApi(`/api/social/favorites/${encodeURIComponent(button.dataset.movieId)}`, { method: "DELETE" });
        await loadFavoriteIds();
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("studioList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    try {
        const following = button.dataset.action === "unfollow-studio";
        await socialApi(`/api/social/studios/${encodeURIComponent(button.dataset.studioId)}/follow`, {
            method: following ? "DELETE" : "POST"
        });
        await loadStudios();
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("blockedUsers").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action='unblock-user']");
    if (!button) return;
    try {
        await socialApi(`/api/social/blocks/${encodeURIComponent(button.dataset.userId)}`, { method: "DELETE" });
        await loadBlockedUsers();
    } catch (error) {
        window.alert(error.message);
    }
});

groupList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-group-id]");
    if (!button) return;
    try {
        if (button.dataset.isMember !== "true") {
            await socialApi(`/api/social/groups/${encodeURIComponent(button.dataset.groupId)}/join`, {
                method: "POST"
            });
            await loadGroups();
        }
        await openGroup(button.dataset.groupId, button.dataset.groupName);
    } catch (error) {
        window.alert(error.message);
    }
});

conversationList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-open-conversation]");
    if (button) void openConversation(
        button.dataset.peerId,
        button.dataset.openConversation,
        button.dataset.requestTargetId
    );
});

chatHeader.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action || !activeChat) return;
    try {
        if (action === "accept-message-request" || action === "reject-message-request") {
            const decision = action === "accept-message-request" ? "accept" : "reject";
            await socialApi(`/api/social/conversations/${encodeURIComponent(activeChat.id)}/${decision}`, {
                method: "POST"
            });
            await loadChatMessages();
            await loadConversations();
        } else if (action === "block-chat-user") {
            if (window.confirm("Toshe wannan mai amfani?")) {
                await socialApi(`/api/social/blocks/${encodeURIComponent(event.target.dataset.userId)}`, { method: "POST" });
                activeChat = null;
                socialChatMessages.replaceChildren();
                messageForm.hidden = true;
                await loadConversations();
                await loadBlockedUsers();
            }
        } else if (action === "report-chat-user") {
            reportPrompt("user", event.target.dataset.userId);
        }
    } catch (error) {
        setStatus(messageStatus, error.message, true);
    }
});

socialChatMessages.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, messageId } = button.dataset;
    try {
        if (action === "reply-message") {
            replyToId = messageId;
            messageForm.elements.content.focus();
            document.getElementById("cancelReplyButton").hidden = false;
            setStatus(messageStatus, "Za a aika saÆ™on a matsayin amsa.");
        } else if (action === "react-message") {
            await socialApi(`/api/social/messages/${encodeURIComponent(messageId)}/reactions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reaction: button.dataset.reaction })
            });
            await loadChatMessages();
        } else if (action === "react-group-message") {
            await socialApi(`/api/social/group-messages/${encodeURIComponent(messageId)}/reactions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reaction: button.dataset.reaction })
            });
            await loadChatMessages();
        } else if (action === "delete-message") {
            if (window.confirm("Goge wannan saÆ™o?")) {
                await socialApi(`/api/social/messages/${encodeURIComponent(messageId)}`, { method: "DELETE" });
                await loadChatMessages();
            }
        } else if (action === "report-message") {
            reportPrompt(button.dataset.targetType, button.dataset.targetId || messageId);
        }
    } catch (error) {
        setStatus(messageStatus, error.message, true);
    }
});

messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!activeChat) return;
    const button = messageForm.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(messageStatus, "Ana aika saÆ™o...");
    try {
        const data = new FormData(messageForm);
        if (!messageForm.elements.attachment.files.length) data.delete("attachment");
        if (replyToId) data.set("replyToId", replyToId);
        const route = activeChat.type === "direct"
            ? `/api/social/conversations/${encodeURIComponent(activeChat.id)}/messages`
            : `/api/social/groups/${encodeURIComponent(activeChat.id)}/messages`;
        await socialApi(route, { method: "POST", body: data });
        messageForm.elements.content.value = "";
        messageForm.elements.movieId.value = "";
        messageForm.elements.authorizedLink.value = "";
        messageForm.elements.attachment.value = "";
        replyToId = null;
        document.getElementById("cancelReplyButton").hidden = true;
        await loadChatMessages();
        await loadConversations();
    } catch (error) {
        setStatus(messageStatus, error.message, true);
    } finally {
        button.disabled = false;
    }
});

document.getElementById("cancelReplyButton").addEventListener("click", () => {
    replyToId = null;
    document.getElementById("cancelReplyButton").hidden = true;
    setStatus(messageStatus, "");
});

document.getElementById("recordVoiceButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (mediaRecorder?.state === "recording") {
        mediaRecorder.stop();
        button.textContent = "Ana ajiye saÆ™on murya...";
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        setStatus(messageStatus, "Wannan browser ba ya tallafa wa É—aukar saÆ™on murya.", true);
        return;
    }
    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recordingTypes = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
        const recordingType = typeof MediaRecorder.isTypeSupported === "function"
            ? recordingTypes.find((type) => MediaRecorder.isTypeSupported(type))
            : "";
        mediaRecorder = recordingType
            ? new MediaRecorder(recordingStream, { mimeType: recordingType })
            : new MediaRecorder(recordingStream);
        const chunks = [];
        mediaRecorder.addEventListener("dataavailable", (eventData) => {
            if (eventData.data.size) chunks.push(eventData.data);
        });
        mediaRecorder.addEventListener("stop", () => {
            const mimeType = mediaRecorder.mimeType || chunks[0]?.type || "audio/webm";
            const blob = new Blob(chunks, { type: mimeType });
            const extension = {
                "audio/mp4": "m4a",
                "audio/ogg": "ogg",
                "audio/webm": "webm"
            }[mimeType.split(";")[0].toLowerCase()] || "webm";
            const file = new File([blob], `voice-message.${extension}`, { type: blob.type });
            const input = document.getElementById("messageAttachment");
            const transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            recordingStream?.getTracks().forEach((track) => track.stop());
            recordingStream = null;
            button.textContent = "An shirya saÆ™on murya";
            setStatus(messageStatus, "An É—auki saÆ™on murya. Danna Aika saÆ™o domin aikawa.");
        }, { once: true });
        mediaRecorder.start();
        button.textContent = "â–  Tsaya";
        setStatus(messageStatus, "Ana É—aukar saÆ™on murya...");
    } catch (error) {
        setStatus(messageStatus, `Ba a iya kunna makirufo ba: ${error.message}`, true);
    }
});

document.getElementById("markNotificationsRead").addEventListener("click", async () => {
    try {
        await socialApi("/api/social/notifications/read", { method: "POST" });
        await loadNotifications();
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("notificationList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, userId, type, entityId } = button.dataset;
    try {
        if (action === "accept-follow" || action === "reject-follow") {
            const decision = action === "accept-follow" ? "accept" : "reject";
            await socialApi(`/api/social/follow-requests/${encodeURIComponent(userId)}/${decision}`, { method: "POST" });
            await loadNotifications();
            await loadFollowRequests();
        } else if (action === "open-notification" && type === "private_message_request") {
            await openConversation(null, entityId);
        } else if (action === "open-notification" && type === "private_message") {
            const data = await socialApi("/api/social/conversations");
            const conversation = data.conversations.find((item) => item.conversationId === entityId);
            if (conversation) await openConversation(conversation.peer.id, entityId, conversation.requestTargetId);
        } else if (action === "open-notification" && type === "group_message") {
            const groupData = await socialApi("/api/social/groups");
            const group = groupData.groups.find((item) => item.id === entityId);
            if (group?.isMember) {
                document.getElementById("chat").scrollIntoView({ behavior: "smooth" });
                await openGroup(group.id, group.name);
            }
        } else if (action === "open-notification" && type === "studio_movie") {
            document.getElementById("movies").scrollIntoView({ behavior: "smooth" });
        }
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("reviewForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
        await socialApi(`/api/social/movies/${encodeURIComponent(form.elements.movieId.value)}/reviews`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                rating: Number(form.elements.rating.value),
                body: form.elements.body.value.trim()
            })
        });
        reviewDialog.close();
        form.reset();
        await loadFeed(currentScope);
    } catch (error) {
        setStatus(document.getElementById("reviewStatus"), error.message, true);
    }
});

function openReview(movieId) {
    if (!currentUser) {
        document.getElementById("accountArea").scrollIntoView({ behavior: "smooth" });
        return;
    }
    const form = document.getElementById("reviewForm");
    form.elements.movieId.value = movieId;
    reviewDialog.showModal();
}

document.getElementById("closeReviewDialog").addEventListener("click", () => reviewDialog.close());

document.addEventListener("click", async (event) => {
    const favorite = event.target.closest("[data-favorite-movie]");
    if (favorite) {
        if (!currentUser) {
            document.getElementById("accountArea").scrollIntoView({ behavior: "smooth" });
            return;
        }
        try { await toggleFavorite(favorite.dataset.favoriteMovie, favorite); }
        catch (error) { window.alert(error.message); }
        return;
    }
    const review = event.target.closest("[data-review-movie]");
    if (review) openReview(review.dataset.reviewMovie);
});

async function handleSocialAction(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action, userId, username } = button.dataset;
    try {
        if (action === "view-user") {
            await openUserProfile(username);
            document.getElementById("profile").scrollIntoView({ behavior: "smooth" });
        } else if (action === "follow-user" || action === "unfollow-user") {
            const following = action === "follow-user";
            const result = await socialApi(`/api/social/users/${encodeURIComponent(userId)}/follow`, {
                method: following ? "POST" : "DELETE"
            });
            if (result.status === "requested") {
                window.alert("An aika buÆ™atar bin asusu.");
            }
            await searchPeople(document.getElementById("peopleSearchInput").value.trim(), peopleResults, {
                message: true,
                manage: true
            });
            if (username) await openUserProfile(username);
            const me = await socialApi("/api/social/me");
            currentUser = me.user;
            await loadCurrentProfile();
        } else if (action === "message-user") {
            await openConversation(userId);
            document.getElementById("chat").scrollIntoView({ behavior: "smooth" });
        } else if (action === "block-user") {
            if (window.confirm("Toshe wannan mai amfani?")) {
                await socialApi(`/api/social/blocks/${encodeURIComponent(userId)}`, { method: "POST" });
                await loadBlockedUsers();
                await searchPeople(document.getElementById("peopleSearchInput").value.trim(), peopleResults, {
                    message: true,
                    manage: true
                });
            }
        } else if (action === "report-user") {
            reportPrompt("user", userId);
        }
    } catch (error) {
        window.alert(error.message);
    }
}

document.getElementById("profile").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const { action } = button.dataset;
    try {
        if (action === "followers" || action === "following") await loadConnections(action);
        else if (action === "follow-studio" || action === "unfollow-studio") {
            const method = action === "follow-studio" ? "POST" : "DELETE";
            await socialApi(`/api/social/studios/${encodeURIComponent(button.dataset.studioId)}/follow`, { method });
            await loadStudios();
        } else if (action === "unblock-user") {
            await socialApi(`/api/social/blocks/${encodeURIComponent(button.dataset.userId)}`, { method: "DELETE" });
            await loadBlockedUsers();
        }
    } catch (error) {
        window.alert(error.message);
    }
});

document.getElementById("groupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const name = form.elements.name.value.trim();
    try {
        const data = await socialApi("/api/social/groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, description: form.elements.description.value.trim() })
        });
        form.reset();
        await loadGroups();
        await openGroup(data.groupId, name);
    } catch (error) {
        window.alert(error.message);
    }
});

window.addEventListener("hf:movies", (event) => renderMovieOptions(event.detail.movies));
window.addEventListener("hf:server-config-changed", () => {
    void loadMoviesForSocial();
    void loadSession();
});
if (Array.isArray(window.hfCurrentMovies)) renderMovieOptions(window.hfCurrentMovies);
else void loadMoviesForSocial();
void loadSession();

// Password toggle functionality
document.querySelectorAll(".toggle-password").forEach((button) => {
    button.addEventListener("click", () => {
        const passwordField = button.closest(".password-field");
        const input = passwordField?.querySelector('input[type="password"], input[type="text"]');
        if (!input) return;
        const isPassword = input.type === "password";
        input.type = isPassword ? "text" : "password";
        button.setAttribute("aria-label", isPassword ? "Cire kalmar sirri" : "Nuna kalmar sirri");
    });
});

// Format phone number input
document.querySelectorAll('input[name="phoneNumber"]').forEach((input) => {
    input.addEventListener("input", (event) => {
        let value = event.target.value.replace(/[^\d+]/g, "");
        if (value.startsWith("+234")) {
            value = "+234 " + value.slice(4).replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3").trim();
        } else if (value.startsWith("234")) {
            value = "+234 " + value.slice(3).replace(/(\d{3})(\d{3})(\d{4})/, "$1 $2 $3").trim();
        } else if (value.startsWith("0")) {
            value = value.replace(/(\d{4})(\d{3})(\d{4})/, "$1 $2 $3").trim();
        }
        event.target.value = value;
    });
});
