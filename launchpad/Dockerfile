# Fabric Chat for one company in ONE container, for hosts that run a single image behind a single
# web address (XO Launchpad). It holds the same seven parts ./chat up starts as seven containers:
# certificate authority, state database, peer, orderer, chaincode, node agent and chat app.
#
# Nothing is compiled here. Every part is copied out of the release's own images, so this image
# runs exactly the programs a normal node of the same release runs. Build those first
# (npm run images in the repository), then:
#
#   docker build --platform linux/amd64 -t fabric-chat-solo:0.3.0 launchpad
#
# A node in this image stands alone: its peer and orderer cannot be reached from outside the
# container, so it cannot share a workspace with another company. See launchpad/README.md.
ARG RELEASE=0.3.0
# The chat app's image. Another tag of it can be given, to try a change to the app in one company only.
ARG APP_IMAGE=fabric-chat-app:${RELEASE}
ARG FABRIC_VERSION=2.5.16
ARG COUCHDB_VERSION=3.4.2

FROM fabric-chat-ctl:${RELEASE} AS ctl
FROM ${APP_IMAGE} AS app
FROM fabric-chat-chaincode:${RELEASE} AS chaincode
FROM hyperledger/fabric-peer:${FABRIC_VERSION} AS peer
FROM hyperledger/fabric-orderer:${FABRIC_VERSION} AS orderer

# CouchDB is the one part that is more than a single program, so its image is the base.
FROM couchdb:${COUCHDB_VERSION}
ARG RELEASE
ARG FABRIC_VERSION
ARG COUCHDB_VERSION
ARG CA_VERSION=1.5.22

# jq is the one tool the admin scripts need that the base lacks. It comes from Debian's own
# packages: the base image's extra package source is not needed and is left out of the update.
RUN rm -f /etc/apt/sources.list.d/couchdb.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends jq \
 && rm -rf /var/lib/apt/lists/*

# Fabric's programs and their settings.
COPY --from=ctl /usr/local/bin/peer /usr/local/bin/configtxgen /usr/local/bin/configtxlator \
     /usr/local/bin/osnadmin /usr/local/bin/discover \
     /usr/local/bin/fabric-ca-client /usr/local/bin/fabric-ca-server /usr/local/bin/
COPY --from=ctl /etc/hyperledger/fabric /etc/hyperledger/fabric
COPY --from=orderer /usr/local/bin/orderer /usr/local/bin/orderer
# How the peer starts a chaincode that runs as a service of its own.
COPY --from=peer /opt/hyperledger/ccaas_builder /opt/hyperledger/ccaas_builder
# The admin scripts: the same ones ./chat up runs, step by step.
COPY --from=ctl /opt/ctl /opt/ctl
# The chat's rules.
COPY --from=chaincode /usr/local/bin/chat /usr/local/bin/chat-chaincode
# The chat app and the Node.js it runs on.
COPY --from=app /usr/local/bin/node /usr/local/bin/node
COPY --from=app /app /opt/chat

# The chat app and the chaincode each run as an ordinary user of their own, as they do in a normal node.
RUN useradd --uid 1000 --create-home chat \
 && useradd --uid 10001 --no-create-home chaincode

COPY start.sh waiting.mjs /opt/solo/
RUN chmod 755 /opt/solo/start.sh

ENV FABRIC_VERSION=${FABRIC_VERSION} \
    CA_VERSION=${CA_VERSION} \
    COUCHDB_VERSION=${COUCHDB_VERSION} \
    RELEASE=${RELEASE} \
    FABRIC_CFG_PATH=/etc/hyperledger/fabric \
    NODE_ENV=production \
    CHAT_STORE=/app/data \
    PORT=3000
EXPOSE 3000
ENTRYPOINT ["tini", "--", "/opt/solo/start.sh"]
CMD []
