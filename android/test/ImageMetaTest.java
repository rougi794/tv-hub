package com.kidstv.home;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;

/** javac -d out ../src/com/kidstv/home/ImageMeta.java ImageMetaTest.java && java -cp out com.kidstv.home.ImageMetaTest */
public class ImageMetaTest {
    static int fails = 0;
    static void ok(boolean c, String name) { System.out.println((c ? "PASS " : "FAIL ") + name); if (!c) fails++; }

    static void seg(ByteArrayOutputStream o, int marker, byte[] body) {
        o.write(0xFF); o.write(marker); int len = body.length + 2; o.write(len >> 8); o.write(len & 0xFF); o.write(body, 0, body.length);
    }

    public static void main(String[] a) throws Exception {
        byte[] scan = { 1, 2, 3, (byte) 0xFF, 0, 4, (byte) 0xFF, (byte) 0xD0, 5, (byte) 0xFF, (byte) 0xD9 };
        ByteArrayOutputStream src = new ByteArrayOutputStream(), want = new ByteArrayOutputStream();
        src.write(0xFF); src.write(0xD8); want.write(0xFF); want.write(0xD8);
        seg(src, 0xE0, "JFIF\0".getBytes()); seg(want, 0xE0, "JFIF\0".getBytes());
        seg(src, 0xE1, "Exif\0\0GPS 24.7136N 46.6753E".getBytes());          // dropped
        seg(src, 0xE2, "ICC_PROFILE\0".getBytes()); seg(want, 0xE2, "ICC_PROFILE\0".getBytes());
        seg(src, 0xED, "Photoshop 3.0\0IPTC".getBytes());                    // dropped
        seg(src, 0xDB, new byte[65]); seg(want, 0xDB, new byte[65]);
        seg(src, 0xDA, new byte[10]); seg(want, 0xDA, new byte[10]);
        src.write(scan); want.write(scan);
        src.write("SEFT trailer: 24.7N 46.6E".getBytes());                // after end of image: dropped

        File dir = Files.createTempDirectory("im").toFile();
        File f = new File(dir, "p.jpg");
        Files.write(f.toPath(), src.toByteArray());
        ImageMeta.stripInPlace(f);
        byte[] got = Files.readAllBytes(f.toPath());
        ok(Arrays.equals(got, want.toByteArray()), "EXIF + IPTC removed, everything else byte-identical");
        ok(!new String(got, "ISO-8859-1").contains("GPS"), "no GPS text left");

        // progressive: two scans with a table between them, and a file that ends without EOI
        ByteArrayOutputStream p = new ByteArrayOutputStream(), pw = new ByteArrayOutputStream();
        for (ByteArrayOutputStream o : new ByteArrayOutputStream[]{p, pw}) {
            o.write(0xFF); o.write(0xD8);
            seg(o, 0xDA, new byte[8]); o.write(new byte[]{9, (byte) 0xFF, 0, 8});
            seg(o, 0xC4, new byte[]{(byte) 0xFF, (byte) 0xD9, 1});          // FF D9 inside a table is not the end
            seg(o, 0xDA, new byte[8]); o.write(new byte[]{7, 7});
        }
        pw.write(0xFF); pw.write(0xD9);
        File prog = new File(dir, "g.jpg");
        Files.write(prog.toPath(), p.toByteArray());
        ImageMeta.stripInPlace(prog);
        ok(Arrays.equals(Files.readAllBytes(prog.toPath()), pw.toByteArray()), "progressive scans kept, missing end added");

        // portrait photo: GPS removed, orientation 6 kept (little-endian EXIF, as phones write it)
        byte[] exif = { 'E','x','i','f',0,0, 'I','I',42,0, 8,0,0,0, 2,0,
            0x12,0x01, 3,0, 1,0,0,0, 6,0,0,0,
            0x25,(byte)0x88, 4,0, 1,0,0,0, 40,0,0,0,  0,0,0,0, 'G','P','S','!' };
        ByteArrayOutputStream r = new ByteArrayOutputStream();
        r.write(0xFF); r.write(0xD8); seg(r, 0xE1, exif); seg(r, 0xDA, new byte[8]); r.write(new byte[]{1, (byte) 0xFF, (byte) 0xD9});
        ok(ImageMeta.orientation(exif) == 6, "orientation read");
        File rf = new File(dir, "r.jpg");
        Files.write(rf.toPath(), r.toByteArray());
        ImageMeta.stripInPlace(rf);
        byte[] rg = Files.readAllBytes(rf.toPath());
        ok(!new String(rg, "ISO-8859-1").contains("GPS"), "portrait: GPS removed");
        ok(ImageMeta.orientation(Arrays.copyOfRange(rg, 6, 6 + 32)) == 6, "portrait: orientation 6 kept");

        File png = new File(dir, "i.png");
        byte[] pngBytes = { (byte) 0x89, 'P', 'N', 'G', 1, 2, 3 };
        Files.write(png.toPath(), pngBytes);
        ImageMeta.stripInPlace(png);
        ok(Arrays.equals(Files.readAllBytes(png.toPath()), pngBytes), "PNG left as it is");

        File bad = new File(dir, "b.jpg");
        byte[] badBytes = { (byte) 0xFF, (byte) 0xD8, (byte) 0xFF, (byte) 0xE1, 0, 50, 1, 2 };   // truncated segment
        Files.write(bad.toPath(), badBytes);
        ImageMeta.stripInPlace(bad);
        ok(Arrays.equals(Files.readAllBytes(bad.toPath()), badBytes), "broken JPEG kept unchanged");
        ok(dir.listFiles().length == 5, "no temporary files left");
        System.out.println(fails == 0 ? "ALL PASS" : fails + " FAILED");
        System.exit(fails);
    }
}
