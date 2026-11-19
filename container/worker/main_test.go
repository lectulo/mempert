package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostAuthAndLease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("X-Job-Lease") != "lease" {
			t.Error("missing auth or lease")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"name":"test"}`))
	}))
	defer server.Close()
	t.Setenv("INTERNAL_URL", server.URL)
	t.Setenv("WORKER_SECRET", "secret")
	var j job
	status, err := post(context.Background(), "/claim", "lease", nil, &j)
	if err != nil || status != 200 || j.Name != "test" {
		t.Fatalf("%d %v %+v", status, err, j)
	}
}
