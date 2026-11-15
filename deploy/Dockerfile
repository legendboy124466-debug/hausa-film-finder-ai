FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/var/lib/hausa-film-finder/database/hausa-film-finder.sqlite \
    MOVIE_UPLOAD_DIR=/var/lib/hausa-film-finder/media/movies \
    POSTER_UPLOAD_DIR=/var/lib/hausa-film-finder/media/posters \
    MERLIN_UPLOAD_DIR=/var/lib/hausa-film-finder/media/merlin \
    MERLIN_MOVIE_UPLOAD_DIR=/var/lib/hausa-film-finder/media/movies/merlin \
    SOCIAL_UPLOAD_DIR=/var/lib/hausa-film-finder/media/social \
    SAMPLE_UPLOAD_DIR=/tmp/hf-processing/samples \
    TMPDIR=/tmp/hf-processing \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    FPCALC_PATH=/usr/bin/fpcalc \
    FINGERPRINT_MAX_CONCURRENT_JOBS=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libchromaprint-tools \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/hausa-film-finder/database /var/lib/hausa-film-finder/media /tmp/hf-processing \
    && chown -R node:node /var/lib/hausa-film-finder /tmp/hf-processing

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node backend ./backend
COPY --chown=node:node fingerprint ./fingerprint
COPY --chown=node:node admin ./admin
COPY --chown=node:node assets ./assets
COPY --chown=node:node ["index.html", "style.css", "app.js", "social.js", "server-config.js", "manifest.webmanifest", "merlin-poster.html", "MERLIN SEASON 1.png", "./"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "backend/server.js"]
