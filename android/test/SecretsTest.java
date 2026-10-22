// Unit test for Secrets.java (plain JDK). Run from android/:
//   javac -d build/test src/com/kidstv/home/Secrets.java test/SecretsTest.java && java -cp build/test com.kidstv.home.SecretsTest
package com.kidstv.home;
public class SecretsTest {
    static int fail = 0;
    static void t(String name, boolean ok) { System.out.println((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; }
    public static void main(String[] a) {
        String h = Secrets.hash("246813");
        t("hash format pbkdf2$60000$salt$hash", h.matches("pbkdf2[$]60000[$][0-9a-f]{32}[$][0-9a-f]{64}"));
        t("hash does not contain the PIN", !h.contains("246813"));
        t("correct PIN verifies", Secrets.verify(h, "246813"));
        t("wrong PIN rejected", !Secrets.verify(h, "891913"));
        t("empty rejected", !Secrets.verify(h, ""));
        t("null rejected", !Secrets.verify(h, null) && !Secrets.verify(null, "x"));
        t("same PIN -> different salt", !Secrets.hash("246813").equals(h));
        String ph = Secrets.hash("Test-Pass-x9 أحمد");
        t("password with Arabic verifies", Secrets.verify(ph, "Test-Pass-x9 أحمد"));
        t("legacy plain text still verifies (migration safety)", Secrets.verify("246813", "246813") && !Secrets.verify("246813", "000000"));
        t("isHash", Secrets.isHash(h) && !Secrets.isHash("246813") && !Secrets.isHash(null));
        t("corrupted hash rejected, no crash", !Secrets.verify("pbkdf2$x$zz$yy", "246813"));
        long t0 = System.nanoTime(); Secrets.verify(h, "246813"); System.out.println("one check on this PC: " + (System.nanoTime() - t0) / 1_000_000 + " ms");
        System.exit(fail);
    }
}
