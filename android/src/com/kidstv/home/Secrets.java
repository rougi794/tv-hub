package com.kidstv.home;

import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * Owner PIN and phone admin password are stored as salted PBKDF2 hashes, never as text (AUDIT-2 N2):
 *   "pbkdf2$<iterations>$<salt hex>$<hash hex>"
 * A value saved by an older version (plain text) still verifies, and is replaced by a hash at the next start.
 */
final class Secrets {
    private static final String PREFIX = "pbkdf2$";
    private static final int ITERATIONS = 60_000;   // ~0.1-0.3 s on a TV box: fine for one entry, slow for guessing
    private static final SecureRandom RANDOM = new SecureRandom();

    private Secrets() { }

    static boolean isHash(String stored) { return stored != null && stored.startsWith(PREFIX); }

    static String hash(String secret) {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        return PREFIX + ITERATIONS + "$" + hex(salt) + "$" + hex(derive(secret, salt, ITERATIONS));
    }

    /** True if `given` matches `stored` (a hash, or legacy plain text). Constant-time comparison. */
    static boolean verify(String stored, String given) {
        if (stored == null || given == null) return false;
        if (!isHash(stored)) return MessageDigest.isEqual(stored.getBytes(), given.getBytes());
        String[] p = stored.split("\\$");
        if (p.length != 4) return false;
        try {
            byte[] expected = unhex(p[3]);
            return MessageDigest.isEqual(expected, derive(given, unhex(p[2]), Integer.parseInt(p[1])));
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] derive(String secret, byte[] salt, int iterations) {
        try {
            PBEKeySpec spec = new PBEKeySpec(secret.toCharArray(), salt, iterations, 256);
            return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("PBKDF2 unavailable", e);
        }
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder(b.length * 2);
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    private static byte[] unhex(String s) {
        byte[] b = new byte[s.length() / 2];
        for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(s.substring(2 * i, 2 * i + 2), 16);
        return b;
    }
}
