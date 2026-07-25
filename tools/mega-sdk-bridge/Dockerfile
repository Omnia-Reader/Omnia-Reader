ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

FROM ${UBUNTU_IMAGE} AS build

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        git \
        libcrypto++-dev \
        libcurl4-openssl-dev \
        libicu-dev \
        libsodium-dev \
        libsqlite3-dev \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /source
COPY . .

RUN cmake \
      -S . \
      -B /build \
      -DCMAKE_BUILD_TYPE=Release \
      -DOMNIA_MEGA_BRIDGE_BUILD_TESTS=ON \
    && cmake --build \
      /build \
      --target omnia-mega-sdk-bridge omnia_mega_bridge_core_tests \
      --parallel 2 \
    && ctest --test-dir /build --output-on-failure

FROM ${UBUNTU_IMAGE} AS runtime

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        libcrypto++8t64 \
        libcurl4t64 \
        libicu74 \
        libsodium23 \
        libsqlite3-0 \
        libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 omnia \
    && useradd \
      --uid 10001 \
      --gid omnia \
      --no-create-home \
      --home-dir /nonexistent \
      --shell /usr/sbin/nologin \
      omnia \
    && install -d -o omnia -g omnia -m 0700 /var/lib/omnia-mega-bridge

COPY --from=build \
  /build/omnia-mega-sdk-bridge \
  /usr/local/bin/omnia-mega-sdk-bridge

ENV OMNIA_MEGA_BRIDGE_HOST=127.0.0.1 \
    OMNIA_MEGA_BRIDGE_PORT=47831 \
    OMNIA_MEGA_BRIDGE_TMP=/var/lib/omnia-mega-bridge

USER 10001:10001

ENTRYPOINT ["/usr/local/bin/omnia-mega-sdk-bridge"]
