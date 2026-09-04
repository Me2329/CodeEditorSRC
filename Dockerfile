# CodeCraft Studio - single-image deployment.
#
# Three stages: the frontend bundle, the compiled core services, and a runtime
# image carrying the toolchains. Building the services separately keeps the Rust
# and Node toolchains out of the final image.

# --------------------------------------------------------------- frontend
FROM node:22-bookworm-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ----------------------------------------------------------- core services
FROM rust:1.82-bookworm AS services
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends g++ make \
    && rm -rf /var/lib/apt/lists/*
COPY core/supervisor/ core/supervisor/
COPY core/analyzer/ core/analyzer/
RUN cd core/supervisor && cargo build --release
RUN make -C core/analyzer all

# ----------------------------------------------------------------- runtime
FROM debian:bookworm-slim AS runtime

# Toolchains plus the isolation primitives the sandbox needs. util-linux
# provides unshare, setpriv and prlimit, which the userns tier depends on.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv \
        gcc g++ make \
        nodejs \
        ruby-full php-cli perl \
        default-jre-headless \
        sqlite3 gawk jq \
        util-linux procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -q -r backend/requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

COPY backend/ backend/
COPY scripts/ scripts/
COPY --from=services /build/core/supervisor/target/release/codecraft-supervisor \
     /usr/local/bin/codecraft-supervisor
COPY --from=services /build/core/analyzer/build/codecraft-analyzer \
     /app/core/analyzer/build/codecraft-analyzer
COPY --from=frontend /build/dist/ /app/frontend/dist/

RUN chmod +x scripts/*.sh scripts/lib/*.sh \
    && mkdir -p /var/tmp/codecraft /run/codecraft

ENV CODECRAFT_WORKSPACE_ROOT=/var/tmp/codecraft \
    CODECRAFT_ANALYZER=/app/core/analyzer/build/codecraft-analyzer \
    CODECRAFT_SOCKET=/run/codecraft/supervisor.sock \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# The gateway itself runs as root so the sandbox can drop privileges per job;
# user code always runs as an unprivileged uid inside a namespace. Run the
# container with --cap-add=SYS_ADMIN (or a seccomp profile permitting
# unshare) so the isolation tiers are available; without it the sandbox
# degrades to the rlimit tier and refuses to pretend otherwise.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health').read()" || exit 1

CMD ["python3", "-m", "uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
