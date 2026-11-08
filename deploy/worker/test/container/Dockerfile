# Disposable "clean machine" for deploy/worker/test/container.sh: real Debian 12 and real systemd, with NOTHING the bootstrap should install
# (no curl, zstd, sudo, tailscale, node, ollama). python3 and openssl are here only for the test's fake Ollama and its local https update server.
FROM debian:12 AS mirror
RUN apt-get update -qq && apt-get install -y -qq zstd >/dev/null
COPY fake-ollama.py /tmp/ollama
RUN set -e; mkdir -p /m/v0.0.1 /s/bin /s/lib/ollama; cp /tmp/ollama /s/bin/ollama; chmod 755 /s/bin/ollama; echo fake > /s/lib/ollama/README; \
    tar -C /s -cf - . | zstd -q -o /m/v0.0.1/ollama-linux-amd64.tar.zst; cp /m/v0.0.1/ollama-linux-amd64.tar.zst /m/v0.0.1/ollama-linux-arm64.tar.zst; \
    cd /m/v0.0.1 && sha256sum ollama-linux-*.tar.zst > sha256sum.txt

FROM debian:12
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus iproute2 procps python3 openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && ln -sf /bin/true /usr/bin/udevadm || true
COPY --from=mirror /m /mirror
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
