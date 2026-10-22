package com.kidstv.home;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Removes the metadata blocks of a JPEG: APP1 (EXIF with the GPS position of the photo, and XMP) and APP13
 * (IPTC / Photoshop). Only the EXIF orientation survives, rewritten into a minimal block, so portrait photos stay upright. The picture data and the colour profile (APP2/ICC) are copied unchanged, so the image
 * looks exactly the same. Streaming: a 25 MB photo is never held in memory.
 */
final class ImageMeta {
    private ImageMeta() { }

    static boolean isJpeg(File f) {
        try (InputStream in = new FileInputStream(f)) {
            return in.read() == 0xFF && in.read() == 0xD8;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Writes `src` without its metadata to `dest`. Returns false (dest unusable) if the file is not a valid JPEG.
     * Stops at the end-of-image marker, so trailers some phones append after the picture (Samsung "SEFT", motion
     * photo video) are dropped as well.
     */
    static boolean stripJpeg(File src, File dest) {
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(src), 64 * 1024));
             OutputStream out = new BufferedOutputStream(new FileOutputStream(dest), 64 * 1024)) {
            if (in.readUnsignedByte() != 0xFF || in.readUnsignedByte() != 0xD8) return false;
            out.write(0xFF);
            out.write(0xD8);
            int marker = -1;                                       // a marker already read by the scan loop
            while (true) {
                if (marker < 0) {
                    if (in.readUnsignedByte() != 0xFF) return false;   // every segment starts with a marker
                    marker = in.readUnsignedByte();
                }
                while (marker == 0xFF) marker = in.readUnsignedByte(); // fill bytes
                if (marker == 0xD9) { out.write(0xFF); out.write(0xD9); return true; }   // end of image
                if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { out.write(0xFF); out.write(marker); marker = -1; continue; }
                int len = in.readUnsignedShort();                 // includes its own two bytes
                if (len < 2) return false;
                if (marker == 0xE1 || marker == 0xED) {            // APP1 (EXIF/GPS, XMP), APP13 (IPTC): dropped
                    byte[] body = new byte[len - 2];
                    in.readFully(body);
                    int rot = marker == 0xE1 ? orientation(body) : 1;
                    if (rot > 1) out.write(orientationOnly(rot));    // keep only "which way is up"
                } else {
                    out.write(0xFF);
                    out.write(marker);
                    out.write(len >> 8);
                    out.write(len & 0xFF);
                    copy(in, out, len - 2);
                }
                boolean scan = marker == 0xDA;
                marker = -1;
                if (scan) marker = copyScan(in, out);              // picture data, up to the next marker
                if (marker == -2) { out.write(0xFF); out.write(0xD9); return true; }   // file ended without EOI
            }
        } catch (Exception e) {
            return false;
        }
    }

    /** EXIF orientation (1..8) of a JPEG file, 1 if absent or unreadable. Reads only the header segments. */
    static int orientation(File f) {
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(f), 16 * 1024))) {
            if (in.readUnsignedByte() != 0xFF || in.readUnsignedByte() != 0xD8) return 1;
            while (true) {
                if (in.readUnsignedByte() != 0xFF) return 1;
                int marker = in.readUnsignedByte();
                while (marker == 0xFF) marker = in.readUnsignedByte();
                if (marker == 0xDA || marker == 0xD9) return 1;      // picture data: no EXIF before it
                int len = in.readUnsignedShort();
                if (len < 2) return 1;
                byte[] body = new byte[len - 2];
                in.readFully(body);
                if (marker == 0xE1) { int o = orientation(body); if (o > 1) return o; }
            }
        } catch (Exception e) {
            return 1;
        }
    }

    /** EXIF orientation (1..8) from an APP1 body, 1 if absent or unreadable. */
    static int orientation(byte[] b) {
        try {
            if (b.length < 14 || b[0] != 'E' || b[1] != 'x' || b[2] != 'i' || b[3] != 'f' || b[4] != 0 || b[5] != 0) return 1;
            final int t = 6;                                       // TIFF header
            boolean le = b[t] == 'I';
            int ifd = t + u32(b, t + 4, le);
            int count = u16(b, ifd, le);
            for (int i = 0; i < count; i++) {
                int e = ifd + 2 + i * 12;
                if (u16(b, e, le) == 0x0112) { int v = u16(b, e + 8, le); return v >= 1 && v <= 8 ? v : 1; }
            }
        } catch (RuntimeException ignored) { }
        return 1;
    }

    private static int u16(byte[] b, int i, boolean le) {
        return le ? (b[i] & 0xFF) | (b[i + 1] & 0xFF) << 8 : (b[i] & 0xFF) << 8 | (b[i + 1] & 0xFF);
    }

    private static int u32(byte[] b, int i, boolean le) {
        return le ? u16(b, i, true) | u16(b, i + 2, true) << 16 : u16(b, i, false) << 16 | u16(b, i + 2, false);
    }

    /** A complete APP1 segment holding nothing but the orientation tag (big-endian TIFF, one IFD entry). */
    static byte[] orientationOnly(int rot) {
        return new byte[]{
            (byte) 0xFF, (byte) 0xE1, 0, 34,                       // APP1, length 34
            'E', 'x', 'i', 'f', 0, 0,
            'M', 'M', 0, 42, 0, 0, 0, 8,                           // TIFF header, IFD0 at 8
            0, 1,                                                  // one entry
            0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, (byte) rot, 0, 0,     // Orientation, SHORT, 1, value
            0, 0, 0, 0                                             // no next IFD
        };
    }

    /** Copies entropy-coded data; returns the marker that ends it, or -2 at end of file. */
    private static int copyScan(DataInputStream in, OutputStream out) throws Exception {
        while (true) {
            int b = in.read();
            if (b < 0) return -2;
            if (b != 0xFF) { out.write(b); continue; }
            int m = in.read();
            while (m == 0xFF) m = in.read();
            if (m < 0) return -2;
            if (m == 0x00 || (m >= 0xD0 && m <= 0xD7)) { out.write(0xFF); out.write(m); continue; }   // stuffed byte / restart
            return m;
        }
    }

    private static void copy(InputStream in, OutputStream out, int n) throws Exception {
        byte[] buf = new byte[8192];
        while (n > 0) {
            int r = in.read(buf, 0, Math.min(buf.length, n));
            if (r < 0) throw new Exception("short segment");
            out.write(buf, 0, r);
            n -= r;
        }
    }

    /** Replaces a JPEG in place by its stripped copy; other formats are left as they are. */
    static void stripInPlace(File f) {
        if (!isJpeg(f)) return;
        File tmp = new File(f.getParentFile(), "." + f.getName() + ".clean");
        if (stripJpeg(f, tmp) && tmp.length() > 0) {
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
        } else {
            tmp.delete();                                          // keep the original rather than break it
        }
    }
}
