package com.kidstv.home;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;

import static com.kidstv.home.HomeActivity.TAG;

/**
 * Real reminders: data/reminders.json (edited from the phone) is turned into one Android alarm for the next due
 * reminder. When it rings, a banner is drawn over whatever app is on screen (YouTube, a series...) with a short
 * sound, for the reminder's own duration (default 15 s), without taking the remote's focus.
 *
 * Home interface only (the kids interface has no reminders).
 * reminders.json: {"reminders":[{"id","time":"HH:MM","text","seconds":5..120?,"days":[0..6]?}]}
 * days: 0 = Sunday ... 6 = Saturday (same as JavaScript); missing or empty = every day.
 */
final class Reminders {
    static final int DEFAULT_SECONDS = 15, MIN_SECONDS = 5, MAX_SECONDS = 120;
    private static final String ACTION = "com.kidstv.home.REMINDER";
    private static final long LATE_OK_MS = 10 * 60 * 1000;   // an alarm delivered late still shows within 10 min
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static View shown;

    private Reminders() { }

    static final class Item {
        String id, time, text;
        int hour, minute, seconds = DEFAULT_SECONDS;
        boolean[] days;                                       // null = every day; index 0 = Sunday
    }

    /** Same folders as LauncherService.resolveRoots(). */
    static File dataFile() {
        File sd = Environment.getExternalStorageDirectory();
        File a = new File(sd, "tv_hub/data/reminders.json");
        if (a.isFile()) return a;
        File b = new File(sd, "kids_tv/data/reminders.json");
        return b.isFile() ? b : a;
    }

    static List<Item> load() {
        List<Item> out = new ArrayList<>();
        try (FileInputStream in = new FileInputStream(dataFile())) {
            byte[] buf = new byte[(int) Math.min(256 * 1024, Math.max(0, in.getChannel().size()))];
            int n = 0, r;
            while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
            JSONArray a = new JSONObject(new String(buf, 0, n, StandardCharsets.UTF_8)).optJSONArray("reminders");
            for (int i = 0; a != null && i < a.length(); i++) {
                Item it = parse(a.optJSONObject(i));
                if (it != null) out.add(it);
            }
        } catch (Exception ignored) { }
        return out;
    }

    static Item parse(JSONObject o) {
        if (o == null) return null;
        String time = o.optString("time", "");
        if (!time.matches("([01]\\d|2[0-3]):[0-5]\\d")) return null;
        Item it = new Item();
        it.id = o.optString("id", time);
        it.time = time;
        it.text = o.optString("text", "").trim();
        if (it.text.isEmpty()) return null;
        it.hour = Integer.parseInt(time.substring(0, 2));
        it.minute = Integer.parseInt(time.substring(3));
        it.seconds = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, o.optInt("seconds", DEFAULT_SECONDS)));
        JSONArray d = o.optJSONArray("days");
        if (d != null && d.length() > 0) {
            it.days = new boolean[7];
            for (int i = 0; i < d.length(); i++) { int v = d.optInt(i, -1); if (v >= 0 && v <= 6) it.days[v] = true; }
        }
        return it;
    }

    /** The phone may only save well-formed reminders (AdminServer). */
    static boolean valid(String json) {
        try {
            JSONArray a = new JSONObject(json).optJSONArray("reminders");
            if (a == null || a.length() > 50) return false;
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (parse(o) == null || o.optString("text").length() > 80) return false;
                if (o.has("seconds") && (o.optInt("seconds", -1) < MIN_SECONDS || o.optInt("seconds") > MAX_SECONDS)) return false;
                JSONArray d = o.optJSONArray("days");
                if (o.has("days") && (d == null || d.length() > 7)) return false;
                for (int k = 0; d != null && k < d.length(); k++) if (d.optInt(k, -1) < 0 || d.optInt(k) > 6) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean onDay(Item it, Calendar c) {
        return it.days == null || it.days[c.get(Calendar.DAY_OF_WEEK) - 1];
    }

    /** Next moment (ms) one of the reminders is due after `now`, or -1. */
    static long next(List<Item> items, long now) {
        long best = -1;
        for (Item it : items) {
            for (int d = 0; d <= 7; d++) {
                Calendar c = Calendar.getInstance();
                c.setTimeInMillis(now);
                c.add(Calendar.DAY_OF_YEAR, d);
                c.set(Calendar.HOUR_OF_DAY, it.hour);
                c.set(Calendar.MINUTE, it.minute);
                c.set(Calendar.SECOND, 0);
                c.set(Calendar.MILLISECOND, 0);
                if (c.getTimeInMillis() > now && onDay(it, c)) {
                    if (best < 0 || c.getTimeInMillis() < best) best = c.getTimeInMillis();
                    break;
                }
            }
        }
        return best;
    }

    private static PendingIntent alarmIntent(Context ctx, long at) {
        Intent i = new Intent(ctx, Receiver.class).setAction(ACTION).putExtra("at", at);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getBroadcast(ctx, 7, i, flags);
    }

    /** (Re)sets the single alarm for the next due reminder. Called at start, after the phone saves, on clock changes. */
    static void schedule(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            am.cancel(alarmIntent(ctx, 0));
            // home interface only: the kids TV has a default reminders.json from the seed data that nobody set
            if ("kids".equals(LauncherService.modeOf(ctx))) { Log.i(TAG, "reminders: off in the kids interface"); return; }
            long at = next(load(), System.currentTimeMillis());
            ctx.getSharedPreferences(LauncherService.PREFS, Context.MODE_PRIVATE).edit().putLong("reminderNext", at).apply();
            if (at < 0) { Log.i(TAG, "reminders: none scheduled"); return; }
            PendingIntent pi = alarmIntent(ctx, at);
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (Build.VERSION.SDK_INT >= 23) {
                if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
            }
            Log.i(TAG, "reminders: next at " + new java.text.SimpleDateFormat("EEE HH:mm", Locale.ROOT).format(new java.util.Date(at))
                    + (exact ? "" : " (inexact)"));
        } catch (Exception e) {
            Log.w(TAG, "reminders: schedule failed " + e);
        }
    }

    /**
     * Alarm rang: show every reminder due at the scheduled moment `at` (or due within the last 10 minutes), once per
     * day each, then schedule the next one. `at` matters for an alarm delivered late after midnight (AUDIT-3 L3):
     * a 23:58 reminder still belongs to the day it was scheduled for.
     */
    static void fire(Context ctx, long at) {
        long now = System.currentTimeMillis();
        SharedPreferences p = ctx.getSharedPreferences(LauncherService.PREFS, Context.MODE_PRIVATE);
        String day = String.format(Locale.ROOT, "%tF", Calendar.getInstance());
        StringBuilder text = new StringBuilder();
        String time = null;
        int seconds = 0;
        for (Item it : load()) {
            Calendar c = null;
            for (long base : new long[]{ at > 0 ? at : now, now }) {     // the scheduled day first, then today
                Calendar k = Calendar.getInstance();
                k.setTimeInMillis(base);
                k.set(Calendar.HOUR_OF_DAY, it.hour);
                k.set(Calendar.MINUTE, it.minute);
                k.set(Calendar.SECOND, 0);
                k.set(Calendar.MILLISECOND, 0);
                long due = k.getTimeInMillis();
                if ((due == at || (due <= now + 1000 && now - due <= LATE_OK_MS)) && onDay(it, k)) { c = k; break; }
            }
            if (c == null) continue;
            String key = "fired:" + String.format(Locale.ROOT, "%tF", c) + ":" + it.id + ":" + it.time;
            if (p.getBoolean(key, false)) continue;
            p.edit().putBoolean(key, true).apply();
            if (text.length() > 0) text.append("  •  ");
            text.append(it.text);
            if (time == null) time = it.time;
            seconds = Math.max(seconds, it.seconds);
        }
        if (text.length() > 0) {
            Log.i(TAG, "reminder shown at " + time + " for " + seconds + " s");
            // kept for the diagnostics page (the system log rotates within hours on the TCL TV, AUDIT-3 U2)
            p.edit().putString("reminderLast", time + "  " + text).putLong("reminderLastAt", now).apply();
            show(ctx.getApplicationContext(), text.toString(), time, seconds);
        }
        cleanOld(p, day);
        schedule(ctx);
    }

    private static void cleanOld(SharedPreferences p, String day) {
        SharedPreferences.Editor e = null;
        for (String k : p.getAll().keySet()) {
            // keys of earlier days (ISO dates sort as text)
            if (k.startsWith("fired:") && k.compareTo("fired:" + day) < 0) { if (e == null) e = p.edit(); e.remove(k); }
        }
        if (e != null) e.apply();
    }

    // ---------------- banner over any app ----------------

    private static int dp(Context c, float v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics());
    }

    /**
     * Not focusable and not touchable: the remote keeps controlling the video underneath.
     * Needs "display over other apps" (SYSTEM_ALERT_WINDOW), granted to TV Hub on both TVs.
     */
    static void show(Context ctx, String text, String time, int seconds) {
        MAIN.post(() -> {
            if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(ctx)) { Log.w(TAG, "reminder: overlay permission missing"); return; }
            WindowManager wm = (WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            hide(wm);
            LinearLayout box = new LinearLayout(ctx);
            box.setOrientation(LinearLayout.HORIZONTAL);
            box.setGravity(Gravity.CENTER_VERTICAL);
            box.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
            box.setPadding(dp(ctx, 22), dp(ctx, 14), dp(ctx, 22), dp(ctx, 14));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(0xF2111827);
            bg.setCornerRadius(dp(ctx, 22));
            bg.setStroke(dp(ctx, 2), 0xFFFACC15);
            box.setBackground(bg);

            TextView bell = new TextView(ctx);
            bell.setText("🔔");
            bell.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 30);
            bell.setPadding(0, 0, 0, 0);
            TextView main = new TextView(ctx);
            main.setText(text);
            main.setTextColor(0xFFFFFFFF);
            main.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 24);
            main.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            main.setMaxWidth(ctx.getResources().getDisplayMetrics().widthPixels * 2 / 3);
            main.setPadding(dp(ctx, 14), 0, dp(ctx, 14), 0);
            TextView when = new TextView(ctx);
            when.setText(time == null ? "" : time);
            when.setTextColor(0xFFFACC15);
            when.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 18);
            box.addView(bell);
            box.addView(main);
            box.addView(when);

            int type = Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                    : WindowManager.LayoutParams.TYPE_PHONE;
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            lp.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
            lp.y = dp(ctx, 28);
            try {
                wm.addView(box, lp);
                shown = box;
            } catch (Exception e) {
                Log.w(TAG, "reminder: overlay refused " + e.getClass().getSimpleName());
                return;
            }
            beep();
            final View mine = box;
            MAIN.postDelayed(() -> { if (shown == mine) hide(wm); }, seconds * 1000L);
        });
    }

    private static void hide(WindowManager wm) {
        if (shown == null) return;
        try { wm.removeView(shown); } catch (Exception ignored) { }
        shown = null;
    }

    /** Two short beeps on the TV's media sound (the notification stream is often muted on TVs). */
    private static void beep() {
        try {
            ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_MUSIC, 70);
            tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 400);
            MAIN.postDelayed(tg::release, 1200);
        } catch (Exception e) {
            Log.w(TAG, "reminder: no sound " + e.getClass().getSimpleName());
        }
    }

    /** Alarm and clock changes. Registered in the manifest (not exported). */
    public static final class Receiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String a = intent.getAction();
            if (ACTION.equals(a)) fire(ctx, intent.getLongExtra("at", 0));
            else schedule(ctx);                                // TIME_SET, TIMEZONE_CHANGED, DATE_CHANGED
        }
    }
}
