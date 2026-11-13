# The admin tool for one company's Fabric Chat node. It holds Fabric's own command-line tools and
# the scripts that use them, and runs for a few seconds at each ./chat up.
ARG FABRIC_VERSION=2.5.16
ARG CA_VERSION=1.5.22
ARG CADDY_VERSION=2.11.9

FROM hyperledger/fabric-ca:${CA_VERSION} AS ca
# The web server that answers for the chat over HTTPS, when a company asks for it.
FROM caddy:${CADDY_VERSION} AS caddy

FROM hyperledger/fabric-tools:${FABRIC_VERSION}
ARG FABRIC_VERSION
ARG CA_VERSION
ARG COUCHDB_VERSION=3.4.2
ARG RELEASE=dev
COPY --from=ca /usr/local/bin/fabric-ca-client /usr/local/bin/fabric-ca-server /usr/local/bin/
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
# The versions this release was built and tested with. ctl env hands them to Docker Compose, so a
# company's nodes always match its admin tool.
ENV FABRIC_VERSION=${FABRIC_VERSION} \
    CA_VERSION=${CA_VERSION} \
    COUCHDB_VERSION=${COUCHDB_VERSION} \
    RELEASE=${RELEASE} \
    FABRIC_CFG_PATH=/etc/hyperledger/fabric
COPY ctl lib.sh workspaces.sh env.sh compose.sh prepare.sh init.sh setup.sh status.sh agent.sh proxy.sh /opt/ctl/
RUN chmod 755 /opt/ctl/ctl
WORKDIR /opt/ctl
ENTRYPOINT ["/opt/ctl/ctl"]
