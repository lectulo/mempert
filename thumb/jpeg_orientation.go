package main

import (
	"bytes"
	"encoding/binary"
	"image"
)

// Read orientation only from EXIF APP1 segments in the JPEG header. Never scan entropy data
// or follow additional TIFF directories (which can describe embedded thumbnails instead).
func jpegOrientation(jpeg []byte) int {
	if len(jpeg) < 2 || jpeg[0] != 0xff || jpeg[1] != 0xd8 {
		return 1
	}
	for pos := 2; pos < len(jpeg) && jpeg[pos] == 0xff; {
		pos++
		for pos < len(jpeg) && jpeg[pos] == 0xff {
			pos++
		}
		if pos == len(jpeg) {
			break
		}
		marker := jpeg[pos]
		pos++
		if marker == 0xda || marker == 0xd9 { // SOS or EOI
			break
		}
		if marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7) { // Standalone markers.
			continue
		}
		if len(jpeg)-pos < 2 {
			break
		}
		size := int(binary.BigEndian.Uint16(jpeg[pos:]))
		if size < 2 || size > len(jpeg)-pos {
			break
		}
		if marker == 0xe1 {
			if tiff, ok := bytes.CutPrefix(jpeg[pos+2:pos+size], []byte("Exif\x00\x00")); ok {
				if orientation := tiffOrientation(tiff); orientation != 0 {
					return orientation
				}
			}
		}
		pos += size
	}
	return 1
}

func tiffOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	if order.Uint16(tiff[2:]) != 42 {
		return 0
	}
	offset := order.Uint32(tiff[4:])
	if offset < 8 || offset > uint32(len(tiff)-2) {
		return 0
	}
	ifd := tiff[offset:]
	count := int(order.Uint16(ifd))
	entries := ifd[2:]
	if count > len(entries)/12 {
		return 0
	}
	for i := 0; i < count; i++ {
		entry := entries[12*i:]
		// Orientation is one inline SHORT, not a reference to data at another offset.
		if order.Uint16(entry) == 0x0112 && order.Uint16(entry[2:]) == 3 && order.Uint32(entry[4:]) == 1 {
			if orientation := int(order.Uint16(entry[8:])); orientation >= 1 && orientation <= 8 {
				return orientation
			}
		}
	}
	return 0
}

// The converter supplies a zero-origin RGBA canvas. A transpose preserves size and ratio limits.
func orientJPEG(src *image.RGBA, orientation int) *image.RGBA {
	if orientation == 1 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	width, height := w, h
	if orientation >= 5 {
		width, height = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dx, dy := x, y
			switch orientation {
			case 2:
				dx = w - 1 - x
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dy = h - 1 - y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.SetRGBA(dx, dy, src.RGBAAt(x, y))
		}
	}
	return dst
}
