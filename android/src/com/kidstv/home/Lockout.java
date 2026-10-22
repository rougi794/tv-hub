package com.kidstv.home;

import android.content.SharedPreferences;

/**
 * Wrong-PIN / wrong-password limiter (AUDIT S2): after 5 failures in a row the secret is locked for 1, 2, 4, 8 ...
 * minutes (max 60), growing with every new lock until a correct entry. Kept in SharedPreferences with wall-clock
 * times, so restarting the app or the TV does not reset it. Each source (TV page, LAN) has its own counter, so
 * someone guessing from the network cannot lock the owner out on the TV.
 */
final class Lockout {
    private static final int TRIES = 5;
    private static final int MAX_LEVEL = 6;          // 2^6 = 64 -> capped at maxMinutes

    private final SharedPreferences prefs;
    private final String key;
    private final long maxMinutes;

    /** maxMinutes: 60 on the TV; 15 for tries from the network, so a stranger cannot keep the owner's phone locked long (AUDIT-2 N6). */
    Lockout(SharedPreferences prefs, String key, long maxMinutes) {
        this.prefs = prefs;
        this.key = key;
        this.maxMinutes = maxMinutes;
    }

    /** Milliseconds until another try is accepted (0 = not locked). */
    synchronized long lockLeft() {
        return Math.max(0, prefs.getLong(key + "Until", 0) - System.currentTimeMillis());
    }

    /** Checks `given` against the stored value (hash or legacy text, see Secrets) and records the result. False while locked. */
    synchronized boolean check(String stored, String given) {
        if (lockLeft() > 0 || given == null) return false;
        if (Secrets.verify(stored, given)) {
            prefs.edit().remove(key + "Fails").remove(key + "Level").remove(key + "Until").apply();
            return true;
        }
        int fails = prefs.getInt(key + "Fails", 0) + 1;
        if (fails < TRIES) {
            prefs.edit().putInt(key + "Fails", fails).apply();
        } else {
            int level = prefs.getInt(key + "Level", 0);
            long minutes = Math.min(maxMinutes, 1L << level);
            prefs.edit().putInt(key + "Fails", 0).putInt(key + "Level", Math.min(MAX_LEVEL, level + 1))
                    .putLong(key + "Until", System.currentTimeMillis() + minutes * 60_000).apply();
            android.util.Log.w(HomeActivity.TAG, key + ": " + TRIES + " wrong tries, locked for " + minutes + " min");
        }
        return false;
    }
}
