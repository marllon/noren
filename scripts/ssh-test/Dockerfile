# The fixture of `pnpm test:ssh` (NOR-F14-04a): a Debian machine with an OpenSSH server that lets one
# user in with one throwaway key, and a `norend` built for Linux from this workspace. Built by
# scripts/test-ssh.mjs from a small context (the two crates, the lock file and these two files) with
# the classic builder, because every layer it leaves in the image store carries the label below and
# so can be found and removed after the run (BuildKit keeps its layers in a cache that cannot be
# told apart from other people's). Not a production image: nothing here is meant to be run twice.

ARG RUN_ID=unset

# Stage 1: norend for Linux. The `rust` image has the compiler and the OpenSSL headers that
# native-tls (the AI client of noren-core) links against.
FROM rust:1-bookworm AS build
ARG RUN_ID
LABEL noren-ssh-test=${RUN_ID}
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build -p norend

# Stage 2: the machine you log in to.
FROM debian:bookworm-slim
ARG RUN_ID
LABEL noren-ssh-test=${RUN_ID}
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-server libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash noren \
    && usermod -p '*' noren \
    && mkdir -p /run/sshd /home/noren/.ssh \
    && test -f /etc/ssh/ssh_host_ed25519_key.pub
COPY --from=build /src/target/debug/norend /usr/local/bin/norend
COPY sshd_config /etc/ssh/sshd_config
COPY authorized_keys /home/noren/.ssh/authorized_keys
RUN chown -R noren:noren /home/noren/.ssh \
    && chmod 700 /home/noren/.ssh \
    && chmod 600 /home/noren/.ssh/authorized_keys \
    && chmod 644 /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
