FROM node:22.23.2-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config curl ca-certificates git file xz-utils \
    libgtk-3-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libssl-dev libdbus-1-dev \
    libayatana-appindicator3-dev librsvg2-dev libxdo-dev xvfb fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

USER node
# Download first: with `curl | sh` a failed download still exits 0 and leaves an image without Rust.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --default-toolchain 1.99.0 --profile minimal --component rustfmt --component clippy \
    && rm /tmp/rustup.sh && "$HOME/.cargo/bin/cargo" --version
ENV PATH="/home/node/.cargo/bin:${PATH}"

USER root
COPY scripts/ /tmp/marxen/scripts/
RUN node /tmp/marxen/scripts/bundle-neovim.mjs --target x86_64-unknown-linux-gnu \
    && node /tmp/marxen/scripts/verify-neovim.mjs --target x86_64-unknown-linux-gnu \
    && mv /tmp/marxen/src-tauri/resources/neovim /opt/neovim \
    && rm -rf /tmp/marxen
ENV PATH="/opt/neovim/bin:${PATH}"
ENV VIMRUNTIME="/opt/neovim/share/nvim/runtime"
USER node
