FROM golang:1.25-alpine AS build
WORKDIR /src
COPY analyze/go.mod analyze/go.sum ./
RUN go mod download
COPY analyze/*.go ./
COPY analyze/fonts ./fonts
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /analyze .
COPY container/worker /worker-src
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /worker /worker-src/main.go

FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=build /analyze /analyze
COPY --from=build /worker /worker
ENV WORKER_KINDS=analyze
ENTRYPOINT ["/worker"]
