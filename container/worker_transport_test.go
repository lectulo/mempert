package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkerTransportScopesCredentials(t *testing.T) {
	t.Setenv("WORKER_SECRET", "secret")
	old := env
	defer func() { env = old }()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/internal/jobs/zip/job/callback/done" {
			if r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("X-Job-Lease") != "lease" {
				t.Error("missing lease credentials")
			}
		} else if r.Header.Get("Authorization") == "Bearer secret" {
			t.Error("worker secret leaked to unrelated URL")
		}
	}))
	defer server.Close()
	env.apiURL, env.token = server.URL+"/internal/jobs/zip/job/callback", "lease"
	for _, p := range []string{"/internal/jobs/zip/job/callback/done", "/internal/jobs/unrelated"} {
		res, err := http.DefaultClient.Get(server.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
	}
}
