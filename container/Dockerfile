FROM golang:1.25-alpine AS build
WORKDIR /src
COPY container/go.mod container/*.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /zipimport .
COPY container/worker /worker-src
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /worker /worker-src/main.go

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /zipimport /zipimport
COPY --from=build /worker /worker
ENV WORKER_KINDS=zip,export
ENTRYPOINT ["/worker"]
