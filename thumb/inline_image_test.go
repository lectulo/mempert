package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"
)

func inlineRequest(size, mime string, input []byte) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /inline-image/{size}", inlineImage)
	r := httptest.NewRequest("POST", "/inline-image/"+size, bytes.NewReader(input))
	r.Header.Set("Content-Type", mime)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestInlineImage(t *testing.T) {
	webp, _ := base64.StdEncoding.DecodeString("UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoEAAMAAgA0JaACdLoB+AADsAD+8MQL/yC5YXXI1/8gP+QH/ID/+PIAAAA=")
	var pngImage, jpegImage bytes.Buffer
	src := image.NewNRGBA(image.Rect(0, 0, 800, 40))
	src.Set(0, 0, color.NRGBA{R: 255, A: 128})
	if err := png.Encode(&pngImage, src); err != nil {
		t.Fatal(err)
	}
	if err := jpeg.Encode(&jpegImage, src, nil); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		mime, size string
		body       []byte
		w, h       int
	}{
		{"image/png", "photo", pngImage.Bytes(), 800, 40},
		{"image/png", "thumbnail", pngImage.Bytes(), 320, 16},
		{"image/jpeg", "thumbnail", jpegImage.Bytes(), 320, 16},
		{"image/webp", "photo", webp, 4, 3},
	} {
		w := inlineRequest(tc.size, tc.mime, tc.body)
		if w.Code != 200 || w.Header().Get("Content-Type") != "image/jpeg" {
			t.Fatalf("%s %s: status %d: %s", tc.mime, tc.size, w.Code, w.Body)
		}
		out, err := jpeg.Decode(w.Body)
		if err != nil || out.Bounds().Dx() != tc.w || out.Bounds().Dy() != tc.h {
			t.Fatalf("%s %s: wrong JPEG: %v, %v", tc.mime, tc.size, out, err)
		}
		if tc.mime == "image/png" {
			r, g, b, _ := out.At(tc.w-1, tc.h-1).RGBA()
			if r != 65535 || g != 65535 || b != 65535 {
				t.Fatal("transparent area did not composite onto white")
			}
		}
	}
	if w := inlineRequest("photo", "image/jpeg", webp); w.Code != 422 {
		t.Fatalf("accepted mislabeled image: %d", w.Code)
	}
}

// Insert a real EXIF APP1 segment into an encoded JPEG, leaving its raster unchanged.
func withExif(jpg, tiff []byte) []byte {
	segment := []byte{0xff, 0xd8, 0xff, 0xe1, 0, 0, 'E', 'x', 'i', 'f', 0, 0}
	binary.BigEndian.PutUint16(segment[4:], uint16(8+len(tiff)))
	return append(append(segment, tiff...), jpg[2:]...)
}

func exifOrientation(orientation int, order binary.ByteOrder) []byte {
	tiff := make([]byte, 26)
	copy(tiff, "II")
	if order == binary.BigEndian {
		copy(tiff, "MM")
	}
	order.PutUint16(tiff[2:], 42)
	order.PutUint32(tiff[4:], 8)
	order.PutUint16(tiff[8:], 1)
	order.PutUint16(tiff[10:], 0x0112)
	order.PutUint16(tiff[12:], 3)
	order.PutUint32(tiff[14:], 1)
	order.PutUint16(tiff[18:], uint16(orientation))
	return tiff
}

func TestInlineJPEGOrientation(t *testing.T) {
	const width, height = 640, 400
	src := image.NewRGBA(image.Rect(0, 0, width, height))
	palette := []color.RGBA{{R: 255, A: 255}, {G: 255, A: 255}, {B: 255, A: 255}, {R: 255, G: 255, A: 255}}
	for i, c := range palette {
		x, y := (i%2)*width/2, (i/2)*height/2
		draw.Draw(src, image.Rect(x, y, x+width/2, y+height/2), image.NewUniform(c), image.Point{}, draw.Src)
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, src, nil); err != nil {
		t.Fatal(err)
	}
	for i, corners := range [][4]int{
		{0, 1, 2, 3}, {1, 0, 3, 2}, {3, 2, 1, 0}, {2, 3, 0, 1},
		{0, 2, 1, 3}, {2, 0, 3, 1}, {3, 1, 2, 0}, {1, 3, 0, 2},
	} {
		orientation := i + 1
		var order binary.ByteOrder = binary.BigEndian
		if orientation%2 == 0 {
			order = binary.LittleEndian
		}
		input := withExif(jpg.Bytes(), exifOrientation(orientation, order))
		for _, size := range []string{"photo", "thumbnail"} {
			w, h := width, height
			if size == "thumbnail" {
				w, h = w/2, h/2
			}
			if orientation >= 5 {
				w, h = h, w
			}
			resp := inlineRequest(size, "image/jpeg", input)
			if resp.Code != 200 {
				t.Fatalf("orientation %d %s: status %d: %s", orientation, size, resp.Code, resp.Body)
			}
			if bytes.Contains(resp.Body.Bytes(), []byte("Exif\x00\x00")) {
				t.Fatalf("orientation %d %s: stale EXIF in derivative", orientation, size)
			}
			out, err := jpeg.Decode(resp.Body)
			if err != nil || out.Bounds().Size() != image.Pt(w, h) {
				t.Fatalf("orientation %d %s: wrong dimensions or invalid JPEG: %v", orientation, size, err)
			}
			for j, index := range corners {
				x, y := w*(1+2*(j%2))/4, h*(1+2*(j/2))/4
				got := color.RGBAModel.Convert(out.At(x, y)).(color.RGBA)
				want := palette[index]
				if (got.R > 128) != (want.R > 128) || (got.G > 128) != (want.G > 128) || (got.B > 128) != (want.B > 128) {
					t.Fatalf("orientation %d %s: quadrant %d has color %v, want %v", orientation, size, j, got, want)
				}
			}
		}
	}
}

func TestInlineJPEGOrientationBounds(t *testing.T) {
	var jpg bytes.Buffer
	src := image.NewGray(image.Rect(0, 0, 2200, 40))
	if err := jpeg.Encode(&jpg, src, nil); err != nil {
		t.Fatal(err)
	}
	valid := exifOrientation(6, binary.LittleEndian)
	badOffset := bytes.Clone(valid)
	binary.LittleEndian.PutUint32(badOffset[4:], 0xffffffff)
	badCount := bytes.Clone(valid)
	binary.LittleEndian.PutUint16(badCount[8:], 0xffff)
	for _, tc := range []struct {
		name, size string
		tiff       []byte
		want       image.Point
	}{
		{"rotated", "photo", valid, image.Pt(103, 2048)},
		{"rotated", "thumbnail", valid, image.Pt(16, 320)},
		{"out of bounds offset", "photo", badOffset, image.Pt(2048, 103)},
		{"out of bounds entry count", "photo", badCount, image.Pt(2048, 103)},
		{"invalid orientation", "photo", exifOrientation(9, binary.BigEndian), image.Pt(2048, 103)},
	} {
		t.Run(tc.name+"/"+tc.size, func(t *testing.T) {
			resp := inlineRequest(tc.size, "image/jpeg", withExif(jpg.Bytes(), tc.tiff))
			if resp.Code != 200 {
				t.Fatalf("status %d: %s", resp.Code, resp.Body)
			}
			out, err := jpeg.DecodeConfig(resp.Body)
			if got := image.Pt(out.Width, out.Height); err != nil || got != tc.want {
				t.Fatalf("got %v, want %v (error: %v)", got, tc.want, err)
			}
		})
	}
}
