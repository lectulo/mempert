// worker is a deliberately serial launcher for the existing one-shot binaries.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type job struct {
	Name        string            `json:"name"`
	Lease       string            `json:"lease"`
	Env         map[string]string `json:"env"`
	Deadline    int64             `json:"deadline"`
	HeartbeatMS int64             `json:"heartbeatMs"`
}

var client = &http.Client{Timeout: 30 * time.Second}

func post(ctx context.Context, path, lease string, body any, result any) (int, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(os.Getenv("INTERNAL_URL"), "/")+path, bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("WORKER_SECRET"))
	req.Header.Set("X-Job-Lease", lease)
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return res.StatusCode, fmt.Errorf("worker API %s: %d", path, res.StatusCode)
	}
	if result != nil && res.StatusCode != 204 {
		err = json.NewDecoder(res.Body).Decode(result)
	}
	return res.StatusCode, err
}

func run(ctx context.Context, kind string, j job) error {
	dir, err := os.MkdirTemp("", "job-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	child, cancel := context.WithDeadline(ctx, time.UnixMilli(j.Deadline))
	defer cancel()
	binary := "/zipimport"
	if kind == "analyze" {
		binary = "/analyze"
	}
	cmd := exec.CommandContext(child, binary)
	cmd.Dir = dir
	// Do not inherit unrelated job credentials or mutable paths from the launcher.
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir, "WORKER_SECRET=" + os.Getenv("WORKER_SECRET")}
	for k, v := range j.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	interval := time.Duration(j.HeartbeatMS) * time.Millisecond
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	base := "/internal/jobs/" + kind + "/" + url.PathEscape(j.Name)
	for {
		select {
		case err := <-done:
			return err
		case <-ticker.C:
			if _, err := post(child, base+"/heartbeat", j.Lease, nil, nil); err != nil {
				// On any uncertain lease, stop immediately rather than risk stale mutations.
				cancel()
				<-done
				return err
			}
		}
	}
}

func main() {
	if os.Getenv("WORKER_SECRET") == "" || os.Getenv("INTERNAL_URL") == "" {
		log.Fatal("WORKER_SECRET and INTERNAL_URL are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	kinds := strings.Split(os.Getenv("WORKER_KINDS"), ",")
	for _, kind := range kinds {
		if kind != "zip" && kind != "export" && kind != "analyze" {
			log.Fatalf("invalid WORKER_KINDS: %q", kind)
		}
	}
	// Resolve the temp root once; each job receives its own cwd and TMPDIR.
	if root := os.Getenv("TMPDIR"); root != "" {
		if err := os.MkdirAll(filepath.Clean(root), 0700); err != nil {
			log.Fatal(err)
		}
	}
	for ctx.Err() == nil {
		worked := false
		for _, kind := range kinds {
			if ctx.Err() != nil {
				break
			}
			var j job
			status, err := post(ctx, "/internal/jobs/"+kind+"/claim", "", nil, &j)
			if err != nil {
				log.Print(err)
				continue
			}
			if status == 204 {
				continue
			}
			worked = true
			err = run(ctx, kind, j)
			message := "worker exited without done callback"
			if err != nil {
				message = err.Error()
			}
			// /done already retired a successful lease; 409 here is expected and harmless.
			_, _ = post(ctx, "/internal/jobs/"+kind+"/"+url.PathEscape(j.Name)+"/finish", j.Lease, map[string]string{"error": message}, nil)
		}
		if !worked {
			select {
			case <-ctx.Done():
			case <-time.After(3 * time.Second):
			}
		}
	}
}
