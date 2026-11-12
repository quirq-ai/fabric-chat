# The chat chaincode as a service: one small image, run once per company next to its peer.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/chat .

FROM alpine:3.23
RUN adduser -D -u 10001 chaincode
COPY --from=build /out/chat /usr/local/bin/chat
USER chaincode
EXPOSE 9999
ENTRYPOINT ["/usr/local/bin/chat"]
