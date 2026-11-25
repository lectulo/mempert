package main

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/image/draw"
	"golang.org/x/image/riff"
	"golang.org/x/image/vp8"
	"golang.org/x/image/vp8l"
	_ "golang.org/x/image/webp"
)

const inlineInputMax = 24 * 1024 * 1024

var inlineSlots = make(chan struct{}, 2)

func inlineImage(w http.ResponseWriter, r *http.Request) {
	maxSide, maxBytes, quality := 2048, 5_000_000, 88
	switch r.PathValue("size") {
	case "thumbnail":
		maxSide, maxBytes, quality = 320, 200_000, 81
	case "photo":
	default:
		http.NotFound(w, r)
		return
	}
	if r.ContentLength > inlineInputMax {
		http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
		return
	}
	format := map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp"}[r.Header.Get("Content-Type")]
	if format == "" {
		http.Error(w, "unsupported image type", http.StatusUnsupportedMediaType)
		return
	}
	select {
	case inlineSlots <- struct{}{}:
		defer func() { <-inlineSlots }()
	default:
		http.Error(w, "image converter busy", http.StatusServiceUnavailable)
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(5 * time.Second))
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, inlineInputMax))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "cannot read image", http.StatusBadRequest)
		}
		return
	}
	config, actual, err := image.DecodeConfig(bytes.NewReader(body))
	if err != nil || actual != format || config.Width < 1 || config.Height < 1 ||
		config.Width > 16000 || config.Height > 16000 || int64(config.Width)*int64(config.Height) > 24_000_000 ||
		format == "webp" && !validWebPFrame(body, config) {
		http.Error(w, "unsupported image or dimensions", http.StatusUnprocessableEntity)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	src, _, err := image.Decode(bytes.NewReader(body))
	if err != nil {
		http.Error(w, "cannot decode image", http.StatusUnprocessableEntity)
		return
	}
	width, height := src.Bounds().Dx(), src.Bounds().Dy()
	if larger := max(width, height); larger > maxSide {
		width, height = max(1, width*maxSide/larger), max(1, height*maxSide/larger)
	}
	// Letterbox unusually long comics without cropping; Telegram limits the photo aspect ratio to 20:1.
	canvasW, canvasH := max(width, (height+19)/20), max(height, (width+19)/20)
	x, y := (canvasW-width)/2, (canvasH-height)/2
	dst := image.NewRGBA(image.Rect(0, 0, canvasW, canvasH))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.ApproxBiLinear.Scale(dst, image.Rect(x, y, x+width, y+height), src, src.Bounds(), draw.Over, nil)
	if format == "jpeg" {
		// Rotate/reflect only the resized canvas, not the potentially much larger decoded image.
		dst = orientJPEG(dst, jpegOrientation(body))
	}
	out := &jpegBuffer{remaining: maxBytes}
	if r.Context().Err() != nil {
		return
	}
	if err = jpeg.Encode(out, dst, &jpeg.Options{Quality: quality}); err != nil {
		http.Error(w, "cannot encode JPEG within size limit", http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", strconv.Itoa(out.Len()))
	_, _ = w.Write(out.Bytes())
}

// DecodeConfig reports the VP8X canvas before seeing the coded frame. Check that
// frame separately so a forged small canvas cannot bypass the decoder's pixel budget.
func validWebPFrame(body []byte, canvas image.Config) bool {
	_, r, err := riff.NewReader(bytes.NewReader(body))
	if err != nil {
		return false
	}
	seenExtended := false
	for i := 0; ; i++ {
		id, n, data, err := r.Next()
		if err != nil {
			return false
		}
		switch string(id[:]) {
		case "VP8X":
			if i != 0 || seenExtended {
				return false
			}
			seenExtended = true
		case "VP8 ":
			if n > inlineInputMax {
				return false
			}
			d := vp8.NewDecoder()
			d.Init(data, int(n))
			h, err := d.DecodeFrameHeader()
			return err == nil && h.Width == canvas.Width && h.Height == canvas.Height
		case "VP8L":
			c, err := vp8l.DecodeConfig(data)
			return err == nil && c.Width == canvas.Width && c.Height == canvas.Height
		case "ANIM", "ANMF":
			return false
		}
	}
}

type jpegBuffer struct {
	bytes.Buffer
	remaining int
}

func (b *jpegBuffer) Write(p []byte) (int, error) {
	if len(p) > b.remaining {
		return 0, errors.New("JPEG exceeds output limit")
	}
	b.remaining -= len(p)
	return b.Buffer.Write(p)
}
