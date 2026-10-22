package com.kidstv.home;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import android.os.Environment;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Local API for the kids page (bound to 127.0.0.1 only, never reachable from the LAN).
 *
 *   GET /ping                         -> {"ok":true,"version":4,"app":"<versionName>","lan":"<ip>","online":bool}
 *   GET /screen?playing=1|0           -> the page reports that a video/channel plays (screen policy, HomeActivity)
 *   GET /apps                         -> all launchable apps [{pkg,label,kid}]
 *   GET /kids                         -> apps the owner chose to show to the child [{pkg,label}]
 *   GET /icon?pkg=P                   -> PNG banner (TV) or icon
 *   GET /launch?pkg=P[&pin=X]         -> start app (pkg "settings" opens Android settings);
 *                                        in kids mode only the child's apps, others need the owner PIN
 *   GET /mode                         -> {"mode":"home"|"kids"} (interface chosen in the owner section)
 *   GET /reminders/status             -> {"next":ms,"last":"HH:MM text","lastAt":ms,"overlay":bool} (diagnostics)
 *   GET /news?limit=N                 -> {"items":[{title,source}],"ok":[..],"failed":[..]} from data/news_sources.json
 *   GET /home/links                   -> ["pkg", ...] apps in the home quick links (data/quicklinks.json)
 *   GET /home/toggle?pin=X&pkg=P      -> add the app to / remove it from the home quick links (owner PIN)
 *   GET /mode/set?pin=X&mode=M        -> switch interface (owner PIN required once one exists)
 *   GET /pin/status                   -> {"set":bool,"lockedFor":ms}
 *   GET /pin/check?pin=X              -> {"ok":bool}
 *   GET /pin/set?pin=NEW[&old=OLD]    -> first time without old, then old required
 *   GET /kids/set?pin=X&pkgs=a,b      -> save the child's app list
 *   GET /adminpass/reset?pin=X        -> clear the phone-admin password (owner sets a new one on the phone)
 *   GET anything else                 -> static file from the web root ("/" = index.html); HTML gets the inline window.fully shim
 *   GET /api/hub/<any of the above>   -> same API; /api/* is never cached by the hosted pages' Service Workers
 *   GET /config.json                  -> private config, never inside the LAN-served folder
 *
 * Only the TV's own pages may use this server (AUDIT S1): a request the browser marks as coming from another site
 * (Sec-Fetch-Site / Origin) is refused with 403 — internet pages opened in the home interface, the YouTube iframe,
 * or an <img>/<form> pointing here can neither read config.json nor launch apps or try PINs.
 * No CORS headers are sent.
 *
 * Other APPS on the TV send no browser headers, so they are told apart by an app token (AUDIT-3 S1): a random value
 * kept in the app's private settings and put into the app's own WebView cookie jar (installCookie) — the server never
 * sends it. Everything except the page files and /ping needs it: config.json, data/, photos and every API.
 */
public class LauncherService extends Service implements Runnable {
    static final int PORT = 8765;
    /** One lock for every data/*.json write, shared with AdminServer (the TV and the phone edit the same files, AUDIT L6). */
    static final Object DATA_LOCK = new Object();
    static final String PREFS = "kids";

    private ServerSocket server;
    private Thread thread;
    private final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(12);
    private AdminServer admin;   // LAN admin page for the owner's phone (port 8080)
    private Lockout pinTv, pinLan;   // owner PIN tries from the TV page / from the phone (LAN), counted separately

    @Override
    public void onCreate() {
        super.onCreate();
        goForeground();
        Reminders.schedule(this);                               // banner over any app at each reminder time
        resolveRoots();
        moveMediaInside();
        removeUnfinishedUploads();
        // uninstalled apps leave the quick links and the child's apps (owner report 2026-10-21)
        android.content.IntentFilter pf = new android.content.IntentFilter(Intent.ACTION_PACKAGE_REMOVED);
        pf.addDataScheme("package");
        try {
            if (Build.VERSION.SDK_INT >= 33) registerReceiver(packageRemoved, pf, android.content.Context.RECEIVER_EXPORTED);
            else registerReceiver(packageRemoved, pf);
        } catch (Exception e) { android.util.Log.w(HomeActivity.TAG, "package receiver: " + e); }
        new Thread(this::pruneMissingApps).start();
        pinTv = new Lockout(prefs(), "pinTv", 60);
        pinLan = new Lockout(prefs(), "pinLan", 15);
        restoreFromDeviceFile();
        hashStoredSecrets();
        thread = new Thread(this, "kids-api");
        thread.start();
        // one-time: drop the admin password set during installation tests (owner creates their own)
        if (prefs().getInt("migration", 0) < 6) prefs().edit().remove("adminPass").putInt("migration", 6).apply();
        admin = new AdminServer(this);
        new Thread(admin, "kids-admin").start();
        new Thread(this::guardLoop, "kids-guard").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // every startForegroundService() must be answered by startForeground(), also when the service already runs;
        // without it the system kills the app 10 s later (crash seen when the screensaver ended, DECISIONS H-019)
        goForeground();
        return START_STICKY;
    }

    private void goForeground() {
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(1, buildNotification(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(1, buildNotification());
        } catch (Exception e) {
            // Android 12+ refuses a foreground start while the app is in the background (e.g. a sticky restart);
            // the servers still run while the process lives, and the home screen restarts the service anyway
            android.util.Log.w(HomeActivity.TAG, "startForeground refused: " + e);
        }
    }

    @Override
    public void onDestroy() {
        stopped = true;
        try { unregisterReceiver(packageRemoved); } catch (Exception ignored) { }
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        if (admin != null) admin.close();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private Notification buildNotification() {
        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            nm.createNotificationChannel(new NotificationChannel("api", "Kids Home", NotificationManager.IMPORTANCE_MIN));
            b = new Notification.Builder(this, "api");
        } else {
            b = new Notification.Builder(this);
        }
        return b.setContentTitle("Kids Home").setSmallIcon(android.R.drawable.ic_menu_view).build();
    }

    // ---------------- server ----------------
    @Override
    public void run() {
        try {
            server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
            while (!server.isClosed()) {
                final Socket s = server.accept();
                pool.execute(() -> handle(s));
            }
        } catch (Exception ignored) {
            // socket closed on destroy
        }
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(5000);
            BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
            String line = in.readLine();
            if (line == null) { s.close(); return; }
            Map<String, String> headers = new java.util.HashMap<>();
            for (int count = 0; count < 100; count++) {
                String h = in.readLine();
                if (h == null || h.isEmpty()) break;
                int i = h.indexOf(':');
                if (i > 0) headers.put(h.substring(0, i).trim().toLowerCase(java.util.Locale.ROOT), h.substring(i + 1).trim());
            }
            String[] parts = line.split(" ");
            Uri uri = Uri.parse("http://x" + (parts.length > 1 ? parts[1] : "/"));
            OutputStream out = s.getOutputStream();
            if (!fromOwnPage(headers)) {
                android.util.Log.w(HomeActivity.TAG, "refused cross-site request: " + uri.getPath()
                        + " site=" + headers.get("sec-fetch-site") + " origin=" + headers.get("origin"));
                send(out, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8), false);
            } else if (needsToken(uri.getPath() == null ? "/" : uri.getPath()) && !hasToken(headers)) {
                // another app on the TV (no app token): no settings, data, photos or API (AUDIT-3 S1)
                android.util.Log.w(HomeActivity.TAG, "refused request without the app token: " + uri.getPath());
                send(out, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8), false);
            } else {
                route(uri, out);
            }
            out.flush();
            s.close();
        } catch (Exception e) {
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    static final String OWN_ORIGIN = "http://127.0.0.1:" + PORT;
    private static final String TOKEN_COOKIE = "hub_local";
    private static String token;

    /** Per-install random token (private settings, never sent by the server). */
    static synchronized String localToken(android.content.Context c) {
        if (token != null) return token;
        SharedPreferences p = c.getSharedPreferences(PREFS, MODE_PRIVATE);
        String t = p.getString("localToken", null);
        if (t == null || t.length() < 32) {
            byte[] b = new byte[24];
            new java.security.SecureRandom().nextBytes(b);
            StringBuilder sb = new StringBuilder();
            for (byte x : b) sb.append(String.format("%02x", x));
            t = sb.toString();
            p.edit().putString("localToken", t).commit();
        }
        return token = t;
    }

    /** Gives the app's WebViews (pages, screensaver) the token as a cookie for the local server. */
    static void installCookie(android.content.Context c) {
        android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
        cm.setCookie(OWN_ORIGIN, TOKEN_COOKIE + "=" + localToken(c) + "; Path=/; HttpOnly; SameSite=Strict");
        cm.flush();
    }

    /** Page files (no secrets) and /ping are open; everything else needs the app token. */
    private static boolean needsToken(String path) {
        String p = path.startsWith("/api/hub/") ? path.substring("/api/hub".length()) : path;
        if (p.equals("/ping") || p.equals("/") || p.equals("/favicon.ico") || p.equals("/sw.js")) return false;
        if (p.endsWith(".html") && p.lastIndexOf('/') == 0) return false;
        return !(p.startsWith("/assets/") || p.startsWith("/icons/") || p.startsWith("/vendor/") || p.startsWith("/channel_icons/"));
    }

    private boolean hasToken(Map<String, String> h) {
        String c = h.get("cookie");
        if (c == null) return false;
        String want = localToken(this);
        for (String part : c.split(";")) {
            String v = part.trim();
            if (v.startsWith(TOKEN_COOKIE + "=")) return java.security.MessageDigest.isEqual(
                    v.substring(TOKEN_COOKIE.length() + 1).getBytes(StandardCharsets.UTF_8), want.getBytes(StandardCharsets.UTF_8));
        }
        return false;
    }

    /**
     * True for requests from the TV's own pages (same origin), for top-level loads made by the app itself
     * (Sec-Fetch-Site "none"), and for clients that send no browser metadata at all (adb/curl during maintenance).
     * Browsers always send Sec-Fetch-Site; Origin is checked as a fallback for older engines.
     */
    private static boolean fromOwnPage(Map<String, String> h) {
        String site = h.get("sec-fetch-site");
        if (site != null) return "same-origin".equals(site) || "none".equals(site);
        String origin = h.get("origin");
        if (origin != null) return OWN_ORIGIN.equals(origin);
        String ref = h.get("referer");
        return ref == null || ref.startsWith(OWN_ORIGIN + "/");
    }

    private void route(Uri u, OutputStream out) throws Exception {
        String path = u.getPath() == null ? "/" : u.getPath();
        // Same API under /api/hub/...: Service Workers of hosted pages (web_project's sw.js) pass /api/* through
        // to the network instead of caching it, so launches and app lists are never served stale.
        if (path.startsWith("/api/hub/")) path = path.substring("/api/hub".length());
        switch (path) {
            case "/ping": json(out, new JSONObject().put("ok", true).put("version", 4).put("app", appVersion()).put("lan", lanAddress())
                    .put("online", online())); return;
            case "/screen": HomeActivity.setPlaying("1".equals(u.getQueryParameter("playing"))); json(out, new JSONObject().put("ok", true)); return;
            case "/mode": json(out, new JSONObject().put("mode", mode())); return;
            case "/reminders/status": {                // diagnostics page: next alarm and the last banner shown
                SharedPreferences p = prefs();
                json(out, new JSONObject().put("mode", mode()).put("next", p.getLong("reminderNext", -1))
                        .put("last", p.getString("reminderLast", "")).put("lastAt", p.getLong("reminderLastAt", 0))
                        .put("overlay", Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(this)));
                return;
            }
            case "/news": {                            // ticker headlines from data/news_sources.json (NewsFetcher)
                int limit = 5;
                try { limit = Math.max(1, Math.min(20, Integer.parseInt(u.getQueryParameter("limit")))); } catch (Exception ignored) { }
                json(out, news.get(webRoot(), limit));
                return;
            }
            case "/home/links": json(out, homeLinkPkgs()); return;
            case "/home/toggle": json(out, new JSONObject().put("ok", toggleHomeLink(u.getQueryParameter("pin"), u.getQueryParameter("pkg")))); return;
            case "/mode/set": json(out, new JSONObject().put("ok", setMode(u.getQueryParameter("pin"), u.getQueryParameter("mode")))); return;
            case "/apps": json(out, appsJson(false)); return;
            case "/kids": json(out, appsJson(true)); return;
            case "/icon": icon(out, u.getQueryParameter("pkg")); return;
            case "/launch": {
                String pkg = u.getQueryParameter("pkg");
                int may = mayLaunch(pkg, u.getQueryParameter("pin"));
                boolean ok = may != LAUNCH_NO && launch(pkg);
                // the guard lets the owner use other apps until back home, at most 15 minutes (AUDIT-2 N3)
                if (ok && may == LAUNCH_OWNER) ownerSessionUntil = System.currentTimeMillis() + OWNER_SESSION_MS;
                json(out, new JSONObject().put("ok", ok));
                return;
            }
            case "/pin/status": json(out, new JSONObject().put("set", prefs().contains("pin")).put("lockedFor", lockLeft())); return;
            case "/pin/check": json(out, new JSONObject().put("ok", checkPin(u.getQueryParameter("pin"))).put("lockedFor", lockLeft())); return;
            case "/pin/set": json(out, new JSONObject().put("ok", setPin(u.getQueryParameter("old"), u.getQueryParameter("pin")))); return;
            case "/kids/set": json(out, new JSONObject().put("ok", setKids(u.getQueryParameter("pin"), u.getQueryParameter("pkgs")))); return;
            case "/adminpass/reset": {                 // forgotten phone-admin password: TV PIN required
                boolean ok = checkPin(u.getQueryParameter("pin"));
                if (ok) { prefs().edit().remove("adminPass").commit(); writeDeviceFile(); if (admin != null) admin.clearSessions(); }
                json(out, new JSONObject().put("ok", ok));
                return;
            }
            default: staticFile(out, path);
        }
    }

    // ---------------- static files from /sdcard/kids_tv (the kids page) ----------------
    // Page files: /sdcard/tv_hub (secrets in /sdcard/tv_hub_private), or the kids TV's legacy
    // /sdcard/kids_tv + /sdcard/kids_private. Both need "appops MANAGE_EXTERNAL_STORAGE allow"
    // (adb on some TVs cannot write the app's own Android/data folder). The app folder is the last fallback.
    // Secrets live outside the web root, so nothing on the LAN can read them.
    private final NewsFetcher news = new NewsFetcher();
    private volatile File webRoot;
    private volatile File privateConfig;
    private volatile boolean usingFallbackRoot = false;
    private long lastResolve = 0;

    /** Current web folder; AdminServer asks every time, so a late-mounted storage is picked up by both servers. */
    File webRoot() { return webRoot; }

    String appVersion() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    // ---------------- photos: app-private storage ----------------
    // Family photos and uploaded icons live in the app's internal storage (/data/data/com.kidstv.home/files/media),
    // not in shared storage: no other app on the TV can read them, with or without a photos permission.
    // Both servers map /today_images/* and /user_icons/* there. Backup: phone admin "download all photos".
    static final String[] MEDIA = { "today_images", "user_icons" };

    File mediaDir(String dir) { return new File(getFilesDir(), "media/" + dir); }

    /**
     * config.json (streaming account, YouTube key, home settings) lives in the app's internal storage (AUDIT-3 S2):
     * no other app can read it, even with "all files" access. Edited from the phone (StreamConfig).
     */
    File configFile() { return privateConfig; }

    private File internalConfig() { return new File(getFilesDir(), "private/config.json"); }

    /**
     * A config.json found in the shared folder (older versions, or one copied there with adb to replace the
     * settings) is moved inside, then removed from the shared folder together with any old .bak copy.
     */
    private void adoptSharedConfig(File shared) {
        if (shared == null) return;
        File bak = new File(shared.getPath() + ".bak");
        synchronized (DATA_LOCK) {
            if (shared.isFile()) {
                File in = internalConfig(), tmp = new File(in.getPath() + ".tmp");
                in.getParentFile().mkdirs();
                if (copyFile(shared, tmp) && tmp.length() == shared.length()) {
                    if (in.isFile()) copyFile(in, new File(in.getPath() + ".bak"));   // the replaced settings stay inside
                    if (!tmp.renameTo(in)) { in.delete(); tmp.renameTo(in); }
                    if (in.isFile() && in.length() == shared.length()) {
                        shared.delete();
                        android.util.Log.i(HomeActivity.TAG, "config.json moved into the app's private storage");
                    }
                } else {
                    tmp.delete();
                }
            }
            if (bak.isFile() && bak.delete()) android.util.Log.i(HomeActivity.TAG, "old config.json.bak removed from shared storage");
        }
    }

    /**
     * One-time move of photos left in shared storage (older versions, or files copied with adb) into the private
     * folder, removing JPEG metadata (GPS position) on the way. Runs at every start, so adb-pushed photos are
     * picked up too.
     */
    private void moveMediaInside() {
        for (String dir : MEDIA) {
            File[] files = new File(webRoot, dir).listFiles();
            File dest = mediaDir(dir);
            dest.mkdirs();
            if (files == null) continue;
            for (File f : files) {
                if (!f.isFile() || f.getName().startsWith(".")) continue;
                File to = new File(dest, f.getName());
                boolean ok = ImageMeta.isJpeg(f) ? ImageMeta.stripJpeg(f, to) : copyFile(f, to);
                if (!ok) ok = copyFile(f, to);                        // not a clean JPEG: keep it as it is
                if (ok && to.length() > 0) { f.delete(); android.util.Log.i(HomeActivity.TAG, "photo moved to private storage: " + dir + "/" + f.getName()); }
            }
        }
        // large photos copied before the phone scaled them (3392 px): a full-screen view of one could stall the kids
        // TV right after a cold boot (low memory). Scaled down once; new uploads are scaled in AdminServer.
        if (!prefs().getBoolean("mediaScaled", false)) {
            File[] files = mediaDir("today_images").listFiles();
            if (files != null) for (File f : files) if (f.isFile() && !f.getName().startsWith(".")) PhotoScale.limit(f);
            prefs().edit().putBoolean("mediaScaled", true).apply();
        }
        // photos that were already inside before metadata removal existed: clean them once
        if (!prefs().getBoolean("mediaStripped2", false)) {
            for (String dir : MEDIA) {
                File[] files = mediaDir(dir).listFiles();
                if (files != null) for (File f : files) if (f.isFile() && !f.getName().startsWith(".")) ImageMeta.stripInPlace(f);
            }
            prefs().edit().putBoolean("mediaStripped2", true).apply();
        }
    }

    private static boolean copyFile(File from, File to) {
        try (FileInputStream in = new FileInputStream(from); java.io.FileOutputStream out = new java.io.FileOutputStream(to)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return true;
        } catch (Exception e) {
            to.delete();
            return false;
        }
    }

    /** Interrupted phone uploads leave hidden ".name.part" files; they are never used, so drop them (AUDIT-2 N11). */
    private void removeUnfinishedUploads() {
        for (String dir : MEDIA) {
            File[] files = mediaDir(dir).listFiles();
            if (files == null) continue;
            for (File f : files) {
                if (f.getName().startsWith(".") && f.getName().endsWith(".part") && f.delete())
                    android.util.Log.i(HomeActivity.TAG, "removed unfinished upload " + dir + "/" + f.getName());
            }
        }
    }

    /** Storage not readable at start (not mounted yet / permission lost): try again, at most every 5 s (AUDIT L5). */
    private void retryRootsIfNeeded() {
        if (!usingFallbackRoot || SystemClock.elapsedRealtime() - lastResolve < 5000) return;
        resolveRoots();
    }

    /** Shown instead of "not found" while the page files cannot be read; reloads itself. */
    private static final String LOADING_HTML = "<!doctype html><html lang=ar dir=rtl><meta charset=utf-8>"
            + "<meta http-equiv=refresh content=5><body style='margin:0;height:100vh;display:flex;align-items:center;"
            + "justify-content:center;background:#0b1020;color:#cbd5e1;font:24px sans-serif'>جاري التحميل…</body></html>";

    private void resolveRoots() {
        lastResolve = SystemClock.elapsedRealtime();
        File sd = Environment.getExternalStorageDirectory();
        File found = null, foundPrivate = null;
        String[][] layouts = { { "tv_hub", "tv_hub_private" }, { "kids_tv", "kids_private" } };
        for (String[] l : layouts) {
            File w = new File(sd, l[0]);
            if (new File(w, "index.html").canRead()) {
                found = w;
                foundPrivate = new File(sd, l[1] + "/config.json");
                break;
            }
        }
        if (found == null) {
            File base = getExternalFilesDir(null);
            if (base == null) base = getFilesDir();
            found = new File(base, "web");
            foundPrivate = new File(base, "private/config.json");
            found.mkdirs();
            foundPrivate.getParentFile().mkdirs();
            usingFallbackRoot = true;
        } else {
            usingFallbackRoot = false;
        }
        webRoot = found;
        privateConfig = internalConfig();
        adoptSharedConfig(foundPrivate);
        android.util.Log.i(HomeActivity.TAG, "web root: " + webRoot);
    }

    private void staticFile(OutputStream out, String path) throws Exception {
        retryRootsIfNeeded();
        if (path.endsWith("/")) path += "index.html";
        File base = webRoot;
        for (String dir : MEDIA) {                              // photos come from the private folder
            if (path.startsWith("/" + dir + "/")) { base = mediaDir(dir); path = path.substring(dir.length() + 1); break; }
        }
        File f = "/config.json".equals(path) ? privateConfig : new File(base, path).getCanonicalFile();
        boolean allowed = f == privateConfig || f.getPath().startsWith(base.getCanonicalPath() + File.separator);
        if (!allowed || !f.isFile()) {
            // A page that cannot be read right now (storage still mounting after a cold boot, permission being
            // re-applied) shows "loading" and retries by itself; a bare 404 stayed on the kids TV after a power cut.
            if (path.endsWith(".html")) {
                android.util.Log.w(HomeActivity.TAG, "page not readable yet: " + path + " (root " + webRoot + ", fallback=" + usingFallbackRoot + ")");
                lastResolve = 0;                                 // look for the folder again on the next request
                usingFallbackRoot = true;
                send(out, 200, "text/html; charset=utf-8", LOADING_HTML.getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            send(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8), false);
            return;
        }
        if (!f.getName().toLowerCase().endsWith(".html")) {
            // pictures can be up to 25 MB: stream them in 64 KB pieces instead of loading them whole (AUDIT-2 N4)
            head(out, 200, mime(f.getName()), f.length(), false);
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        byte[] body = new byte[(int) f.length()];            // HTML pages are small and need the shim injected
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0, n;
            while (off < body.length && (n = in.read(body, off, body.length - off)) > 0) off += n;
        }
        send(out, 200, mime(f.getName()), injectShim(body), false);
    }

    /**
     * Pages written for Fully Kiosk call window.fully.*; this shim maps those calls to the local API.
     * Injected only into pages served here (127.0.0.1), never into iframes from other sites.
     * If Fully itself shows the page, its own window.fully wins.
     */
    private static final String SHIM =
            "(function(){if(window.fully)return;" +
            "function get(p){try{var x=new XMLHttpRequest();x.open('GET',p,false);x.send();return x.status===200?x.responseText:'[]';}catch(e){return '[]';}}" +
            "window.fully={" +
            // vendors name their settings app differently (TCL: com.tcl.settings); fall back to the system settings screen
            "startApplication:function(p){fetch('/api/hub/launch?pkg='+encodeURIComponent(p),{cache:'no-store'}).then(function(r){return r.json();})" +
            ".then(function(j){if(!j.ok&&/settings/i.test(p))fetch('/api/hub/launch?pkg=settings',{cache:'no-store'});}).catch(function(){});}," +
            "loadUrl:function(u){if(/^https?:\\/\\//i.test(String(u)))location.href=u;}," +   // never javascript:/data: (AUDIT S3)
            "getInstalledApps:function(){return get('/api/hub/apps');}" +
            "};" +
            "window.tvHub={native:true};})();";

    private static byte[] injectShim(byte[] html) {
        String s = new String(html, StandardCharsets.UTF_8);
        String tag = "<script>" + SHIM + "</script>";   // inline: a Service Worker can never serve a stale copy
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<head[^>]*>", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(s);
        s = m.find() ? s.substring(0, m.end()) + tag + s.substring(m.end()) : tag + s;
        return s.getBytes(StandardCharsets.UTF_8);
    }

    static String mime(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "application/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".ico")) return "image/x-icon";
        if (n.endsWith(".woff2")) return "font/woff2";
        if (n.endsWith(".woff")) return "font/woff";
        if (n.endsWith(".ttf")) return "font/ttf";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".ogg")) return "audio/ogg";
        if (n.endsWith(".wav")) return "audio/wav";
        if (n.endsWith(".txt")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // ---------------- apps ----------------
    Map<String, String> launchableApps() {
        PackageManager pm = getPackageManager();
        Map<String, String> apps = new LinkedHashMap<>();
        for (String cat : new String[]{Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER}) {
            List<ResolveInfo> list = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(cat), 0);
            for (ResolveInfo ri : list) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(getPackageName()) || apps.containsKey(pkg)) continue;
                apps.put(pkg, String.valueOf(ri.loadLabel(pm)));
            }
        }
        return apps;
    }

    private JSONArray appsJson(boolean onlyKids) throws Exception {
        Set<String> kids = kidsSet();
        JSONArray arr = new JSONArray();
        Map<String, String> apps = launchableApps();
        if (onlyKids) {
            for (String pkg : kids) {  // keep the owner's order
                if (apps.containsKey(pkg)) arr.put(new JSONObject().put("pkg", pkg).put("label", apps.get(pkg)));
            }
        } else {
            for (Map.Entry<String, String> e : apps.entrySet()) {
                arr.put(new JSONObject().put("pkg", e.getKey()).put("label", e.getValue()).put("kid", kids.contains(e.getKey())));
            }
        }
        return arr;
    }

    private boolean launch(String pkg) {
        if (pkg == null) return false;
        Intent i;
        if ("settings".equals(pkg)) {
            i = new Intent(Settings.ACTION_SETTINGS);
        } else {
            PackageManager pm = getPackageManager();
            i = pm.getLeanbackLaunchIntentForPackage(pkg);
            if (i == null) i = pm.getLaunchIntentForPackage(pkg);
            if (i == null) return false;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        try { startActivity(i); return true; } catch (Exception e) { return false; }
    }

    private void icon(OutputStream out, String pkg) throws Exception {
        byte[] png = iconPng(pkg);
        if (png == null) { send(out, 404, "text/plain", new byte[0], false); return; }
        send(out, 200, "image/png", png, true);
    }

    /** PNG of the app's TV banner (or icon), or null if the app is unknown. Also used by the phone admin server. */
    byte[] iconPng(String pkg) {
        PackageManager pm = getPackageManager();
        Drawable d = null;
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            d = pm.getApplicationBanner(ai);
            if (d == null) d = pm.getApplicationIcon(ai);
        } catch (Exception ignored) { }
        if (d == null) return null;
        Bitmap bmp;
        if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) {
            bmp = ((BitmapDrawable) d).getBitmap();
        } else {
            int w = Math.max(1, d.getIntrinsicWidth() > 0 ? d.getIntrinsicWidth() : 192);
            int h = Math.max(1, d.getIntrinsicHeight() > 0 ? d.getIntrinsicHeight() : 192);
            bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bmp);
            d.setBounds(0, 0, w, h);
            d.draw(c);
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
        return bos.toByteArray();
    }

    // ---------------- interface mode ("home" / "kids") ----------------
    // Default: kids on the kids TV's legacy layout (/sdcard/kids_tv), home elsewhere. Changing it needs the owner PIN.
    String mode() { return modeOf(this); }

    /** Phone admin: a channel list may only hold numeric stream ids and local icons (AUDIT-2 N10). */
    /** The TV's IPv4 address on the home network ("" if none): the pages show the phone admin link (UX-AUDIT A7). */
    static String lanAddress() {
        try {
            for (java.net.NetworkInterface ni : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (java.net.InetAddress a : java.util.Collections.list(ni.getInetAddresses())) {
                    if (a instanceof java.net.Inet4Address && a.isSiteLocalAddress()) return a.getHostAddress();
                }
            }
        } catch (Exception ignored) { }
        return "";
    }

    /** The TV reaches the internet (Android checked the network: "validated"); false without a network. */
    private boolean online() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                android.net.Network n = cm.getActiveNetwork();
                android.net.NetworkCapabilities c = n == null ? null : cm.getNetworkCapabilities(n);
                return c != null && c.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            }
            android.net.NetworkInfo i = cm.getActiveNetworkInfo();
            return i != null && i.isConnected();
        } catch (Exception e) {
            return true;                                        // unknown: do not show "offline"
        }
    }

    static boolean validChannels(String text) {
        try {
            JSONArray ch = new JSONObject(text).optJSONArray("channels");
            if (ch == null || ch.length() > 200) return false;
            for (int i = 0; i < ch.length(); i++) {
                JSONObject c = ch.optJSONObject(i);
                if (c == null || c.optString("name").trim().isEmpty() || c.optString("name").length() > 60) return false;
                String id = c.optString("id"), url = c.optString("url", "");
                // provider channel: number only. Direct link (free channel, no account): id "u" + letters/digits + http(s) URL
                boolean direct = id.matches("u[a-z0-9]{4,16}") && url.matches("https?://[^\\s\"'<>\\\\]{4,500}");
                if (!id.matches("\\d{1,10}") && !direct) return false;
                if (!direct && !url.isEmpty()) return false;
                String icon = c.optString("icon", "");
                // channel_icons/: logos from the provider; user_icons/: logos uploaded from the phone (UX-AUDIT K3)
                if (!icon.isEmpty() && !icon.matches("(channel_icons|user_icons)/[A-Za-z0-9_.-]{1,80}")) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** Same rule as resolveRoots(): the kids TV's legacy folder alone means kids by default. Used by HomeActivity too. */
    static String modeOf(android.content.Context c) {
        File sd = Environment.getExternalStorageDirectory();
        boolean legacyKids = !new File(sd, "tv_hub/index.html").canRead() && new File(sd, "kids_tv/index.html").canRead();
        String fallback = legacyKids ? "kids" : "home";
        String saved = readDeviceFile().optString("mode", "");          // survives "clear data" / reinstall (AUDIT L2)
        if ("kids".equals(saved) || "home".equals(saved)) fallback = saved;
        String m = c.getSharedPreferences(PREFS, MODE_PRIVATE).getString("mode", fallback);
        return "kids".equals(m) ? "kids" : "home";
    }

    // ---------------- device file: <private folder>/device.json (AUDIT L2) ----------------
    // The app's own data (SharedPreferences) is wiped by "clear data" or a reinstall; the interface and the child's
    // app list are also kept next to config.json, so a kids TV never falls back to the open home interface.
    static File deviceFile() {
        File sd = Environment.getExternalStorageDirectory();
        boolean legacy = !new File(sd, "tv_hub/index.html").canRead() && new File(sd, "kids_tv/index.html").canRead();
        return new File(sd, (legacy ? "kids_private" : "tv_hub_private") + "/device.json");
    }

    static JSONObject readDeviceFile() {
        File f = deviceFile();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) Math.min(f.length(), 64 * 1024)];
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            return new JSONObject(new String(b, 0, off, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /**
     * Values saved as text by older versions become hashes now, without the owner typing them again (N2).
     * Also refreshes device.json so it carries the hashes.
     */
    private void hashStoredSecrets() {
        SharedPreferences.Editor e = prefs().edit();
        boolean changed = false;
        for (String key : new String[]{"pin", "adminPass"}) {
            String v = prefs().getString(key, null);
            if (v != null && !Secrets.isHash(v)) { e.putString(key, Secrets.hash(v)); changed = true; }
        }
        if (changed) { e.commit(); android.util.Log.i(HomeActivity.TAG, "stored secrets converted to hashes"); }
        writeDeviceFile();
    }

    /** The phone admin password changed or was reset: keep device.json in step. */
    void secretsChanged() { writeDeviceFile(); }

    synchronized void writeDeviceFile() {
        try {
            JSONObject j = readDeviceFile();                  // keeps hand-set options such as "allowSleep"
            j.put("mode", prefs().getString("mode", mode()))
                    .put("kids", prefs().getString("kids", "")).put("updatedAt", System.currentTimeMillis());
            j.remove("pinHash");
            j.remove("adminHash");
            String pin = prefs().getString("pin", null), admin = prefs().getString("adminPass", null);
            if (Secrets.isHash(pin)) j.put("pinHash", pin);          // hashes only, never the text (N2)
            if (Secrets.isHash(admin)) j.put("adminHash", admin);
            File f = deviceFile(), tmp = new File(f.getPath() + ".tmp");
            f.getParentFile().mkdirs();
            try (java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp)) { fo.write(j.toString(2).getBytes(StandardCharsets.UTF_8)); }
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
        } catch (Exception e) {
            android.util.Log.w(HomeActivity.TAG, "device.json not written: " + e);
        }
    }

    /** After "clear data": take the interface, the child's apps and the secret hashes back from device.json. */
    private void restoreFromDeviceFile() {
        JSONObject d = readDeviceFile();
        SharedPreferences.Editor e = prefs().edit();
        boolean changed = false;
        if (!prefs().contains("mode") && d.has("mode")) { e.putString("mode", d.optString("mode")); changed = true; }
        if (!prefs().contains("kids") && d.has("kids")) { e.putString("kids", d.optString("kids")); changed = true; }
        // only hashes are ever written there; a lost PIN must not let the next person holding the remote create one (N2)
        if (!prefs().contains("pin") && Secrets.isHash(d.optString("pinHash", null))) { e.putString("pin", d.optString("pinHash")); changed = true; }
        if (!prefs().contains("adminPass") && Secrets.isHash(d.optString("adminHash", null))) { e.putString("adminPass", d.optString("adminHash")); changed = true; }
        if (changed) { e.apply(); android.util.Log.i(HomeActivity.TAG, "restored mode/kids from " + deviceFile()); }
        if (!deviceFile().exists() && prefs().contains("mode")) writeDeviceFile();   // devices set up before v21
    }

    // ---------------- home quick links (data/quicklinks.json, also edited from the phone admin) ----------------
    private File quickLinksFile() { return new File(webRoot, "data/quicklinks.json"); }

    private JSONArray readQuickLinks() {
        File f = quickLinksFile();
        synchronized (DATA_LOCK) { return readQuickLinksLocked(f); }
    }

    private static JSONArray readQuickLinksLocked(File f) {
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = new byte[(int) f.length()];
            int off = 0, n;
            while (off < b.length && (n = in.read(b, off, b.length - off)) > 0) off += n;
            return new JSONArray(new String(b, 0, off, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /**
     * Removes links to apps that are no longer installed from data/quicklinks.json and from the child's apps
     * (owner report 2026-10-21: an app uninstalled from the Play Store stayed in "quick access").
     * Called when a package is removed and once at start (covers removals while the service was not running).
     */
    void pruneMissingApps() {
        java.util.Set<String> have = launchableApps().keySet();
        if (have.isEmpty()) return;                       // package list not available: never wipe everything
        synchronized (DATA_LOCK) {
            try {
                File f = quickLinksFile();
                if (f.isFile()) {
                    JSONArray links = readQuickLinksLocked(f), next = new JSONArray();
                    for (int i = 0; i < links.length(); i++) {
                        JSONObject l = links.optJSONObject(i);
                        if (l != null && "app".equals(l.optString("type")) && !l.optString("pkg").isEmpty()
                                && !have.contains(l.optString("pkg"))) continue;
                        next.put(links.get(i));
                    }
                    if (next.length() != links.length()) {
                        File tmp = new File(f.getPath() + ".tmp");
                        try (java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp)) { fo.write(next.toString(2).getBytes(StandardCharsets.UTF_8)); }
                        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
                        android.util.Log.i(HomeActivity.TAG, "quick links: removed " + (links.length() - next.length()) + " uninstalled app(s)");
                    }
                }
            } catch (Exception e) {
                android.util.Log.w(HomeActivity.TAG, "prune quick links failed", e);
            }
            java.util.Set<String> kids = kidsSet();
            StringBuilder sb = new StringBuilder();
            for (String p : kids) if (have.contains(p)) { if (sb.length() > 0) sb.append(','); sb.append(p); }
            if (!sb.toString().equals(String.join(",", kids))) prefs().edit().putString("kids", sb.toString()).apply();
        }
    }

    private final android.content.BroadcastReceiver packageRemoved = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context c, Intent i) {
            if (i.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return;   // an update, not an uninstall
            new Thread(LauncherService.this::pruneMissingApps).start();
        }
    };

    private JSONArray homeLinkPkgs() {
        JSONArray links = readQuickLinks(), out = new JSONArray();
        for (int i = 0; i < links.length(); i++) {
            JSONObject l = links.optJSONObject(i);
            if (l != null && "app".equals(l.optString("type")) && !l.optString("pkg").isEmpty()) out.put(l.optString("pkg"));
        }
        return out;
    }

    /** Adds the app at the end of the quick links, or removes every link to it. Same entry shape as the phone admin. */
    private boolean toggleHomeLink(String pin, String pkg) {
        if (pkg == null || !pkg.matches("[A-Za-z0-9_.]+") || !checkPin(pin)) return false;
        synchronized (DATA_LOCK) { return toggleHomeLinkLocked(pkg); }
    }

    private boolean toggleHomeLinkLocked(String pkg) {
        try {
            JSONArray links = readQuickLinks(), next = new JSONArray();
            boolean removed = false;
            for (int i = 0; i < links.length(); i++) {
                JSONObject l = links.optJSONObject(i);
                if (l != null && "app".equals(l.optString("type")) && pkg.equals(l.optString("pkg"))) { removed = true; continue; }
                next.put(links.get(i));
            }
            if (!removed) {
                String label = launchableApps().get(pkg);
                if (label == null) return false;
                next.put(new JSONObject().put("type", "app").put("label", label).put("pkg", pkg)
                        .put("icon", "/api/hub/icon?pkg=" + pkg));
            }
            File f = quickLinksFile(), tmp = new File(f.getPath() + ".tmp");
            f.getParentFile().mkdirs();
            try (java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp)) { fo.write(next.toString(2).getBytes(StandardCharsets.UTF_8)); }
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private boolean setMode(String pin, String m) {
        if (!"home".equals(m) && !"kids".equals(m)) return false;
        if (pinIsSet()) {
            if (!checkPin(pin)) return false;
        } else if ("kids".equals(mode()) && "home".equals(m)) {
            // kids TV whose PIN was lost (data cleared): the owner creates a new PIN before leaving kids mode
            return false;
        }
        // (a new device with no PIN and no kids setting yet: the installer sets the interface before handing it over)
        prefs().edit().putString("mode", m).apply();
        writeDeviceFile();
        Reminders.schedule(this);                              // reminders run in the home interface only
        return true;
    }

    private static final int LAUNCH_NO = 0, LAUNCH_YES = 1, LAUNCH_OWNER = 2;

    /** In kids mode only the apps the owner chose may start, unless the owner PIN comes with the request. */
    private int mayLaunch(String pkg, String pin) {
        if (pkg == null) return LAUNCH_NO;
        if (!"kids".equals(mode())) return LAUNCH_YES;
        if (kidsSet().contains(pkg)) return LAUNCH_YES;
        return pin != null && checkPin(pin) ? LAUNCH_OWNER : LAUNCH_NO;
    }

    // ---------------- kids guard (AUDIT L3) ----------------
    // In kids mode, if an app outside the child's list comes to the front (e.g. a kids app opened Play Store or a
    // browser), the home screen is brought back. Needs "usage access", granted once with
    //   adb shell appops set com.kidstv.home GET_USAGE_STATS allow      (revoke: ... GET_USAGE_STATS default)
    // Without it the guard stays off. Apps the owner opens with the PIN are allowed until TV Hub is in front again.
    private static final long OWNER_SESSION_MS = 15 * 60 * 1000;
    private volatile long ownerSessionUntil = 0;
    private volatile boolean stopped = false;
    /** Google sign-in / account / payment screens are allowed only when they open right over one of the child's apps. */
    private static final Set<String> AFTER_KIDS_APP_OK = new HashSet<>(java.util.Arrays.asList("com.google.android.gms"));
    private static final Set<String> ALWAYS_OK = new HashSet<>(java.util.Arrays.asList(
            "android", "com.android.systemui", "com.android.permissioncontroller", "com.google.android.permissioncontroller",
            "com.google.android.apps.tv.dreamx", "com.google.android.backdrop", "com.android.dreams.basic"));

    private boolean hasUsageAccess() {
        try {
            android.app.AppOpsManager ops = (android.app.AppOpsManager) getSystemService(APP_OPS_SERVICE);
            int mode = Build.VERSION.SDK_INT >= 29
                    ? ops.unsafeCheckOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getPackageName())
                    : ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), getPackageName());
            return mode == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    private void guardLoop() {
        android.app.usage.UsageStatsManager usm = (android.app.usage.UsageStatsManager) getSystemService(USAGE_STATS_SERVICE);
        String front = null;
        boolean overKidsApp = false;        // the last app in front before a Google screen was one of the child's apps
        long since = System.currentTimeMillis();
        while (!stopped) {
            try { Thread.sleep(1500); } catch (InterruptedException e) { return; }
            try {
                if (!"kids".equals(mode()) || !hasUsageAccess()) { front = null; since = System.currentTimeMillis(); continue; }
                long now = System.currentTimeMillis();
                android.app.usage.UsageEvents ev = usm.queryEvents(since - 2000, now);
                android.app.usage.UsageEvents.Event e = new android.app.usage.UsageEvents.Event();
                while (ev.hasNextEvent()) {
                    ev.getNextEvent(e);
                    if (e.getEventType() == android.app.usage.UsageEvents.Event.MOVE_TO_FOREGROUND) front = e.getPackageName();
                }
                since = now;
                if (front == null) continue;
                if (front.equals(getPackageName())) { ownerSessionUntil = 0; overKidsApp = false; continue; }
                if (kidsSet().contains(front)) { overKidsApp = true; continue; }
                if (System.currentTimeMillis() < ownerSessionUntil || ALWAYS_OK.contains(front)) continue;
                if (overKidsApp && AFTER_KIDS_APP_OK.contains(front)) continue;
                android.util.Log.w(HomeActivity.TAG, "kids guard: " + front + " is not allowed, back to the home screen");
                startActivity(new Intent(this, HomeActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
                front = null;
            } catch (Exception ex) {
                android.util.Log.w(HomeActivity.TAG, "kids guard: " + ex);
            }
        }
    }

    // ---------------- PIN + kids list ----------------
    private SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }

    private long lockLeft() { return pinTv.lockLeft(); }

    boolean pinIsSet() { return prefs().contains("pin"); }

    /** Owner PIN check from the phone admin server (LAN): its own counter, see Lockout. */
    boolean checkOwnerPin(String pin) { return pinLan.check(prefs().getString("pin", null), pin); }

    long ownerPinLanLockLeft() { return pinLan.lockLeft(); }

    // The hash check costs ~1 s on a TV box; the owner panel checks the PIN on every action. After a correct entry the
    // PIN is remembered in memory for 10 minutes (never on disk), so the following actions answer at once.
    private static final long PIN_CACHE_MS = 10 * 60 * 1000;
    private String pinCache;
    private long pinCacheUntil;

    private synchronized boolean checkPin(String pin) {
        if (pin != null && pin.equals(pinCache) && SystemClock.elapsedRealtime() < pinCacheUntil && pinTv.lockLeft() == 0) return true;
        boolean ok = pinTv.check(prefs().getString("pin", null), pin);
        if (ok) { pinCache = pin; pinCacheUntil = SystemClock.elapsedRealtime() + PIN_CACHE_MS; }
        return ok;
    }

    /** New PINs: 6 to 8 digits (AUDIT S2). PINs created earlier with 4-5 digits keep working until changed. */
    private synchronized boolean setPin(String old, String pin) {
        if (pin == null || !pin.matches("\\d{6,8}")) return false;
        if (prefs().contains("pin") && !checkPin(old)) return false;
        prefs().edit().putString("pin", Secrets.hash(pin)).commit();
        pinCache = null;                                    // the old PIN must not keep working from memory
        writeDeviceFile();
        return true;
    }

    Set<String> kidsSet() {
        String s = prefs().getString("kids", "");
        Set<String> set = new java.util.LinkedHashSet<>();
        for (String p : s.split(",")) if (!p.trim().isEmpty()) set.add(p.trim());
        return set;
    }

    private boolean setKids(String pin, String pkgs) {
        if (!checkPin(pin)) return false;
        saveKids(pkgs);
        return true;
    }

    /** Saves the child's app list (comma separated, owner's order). Callers check the PIN or the phone password. */
    void saveKids(String pkgs) {
        Set<String> seen = new HashSet<>();
        StringBuilder sb = new StringBuilder();
        for (String p : (pkgs == null ? "" : pkgs).split(",")) {
            p = p.trim();
            if (p.matches("[A-Za-z0-9_.]+") && seen.add(p)) { if (sb.length() > 0) sb.append(','); sb.append(p); }
        }
        prefs().edit().putString("kids", sb.toString()).apply();
        writeDeviceFile();
    }

    // ---------------- http helpers ----------------
    private void json(OutputStream out, Object o) throws Exception {
        send(out, 200, "application/json; charset=utf-8", o.toString().getBytes(StandardCharsets.UTF_8), false);
    }

    private void send(OutputStream out, int code, String type, byte[] body, boolean cache) throws Exception {
        head(out, code, type, body.length, cache);
        out.write(body);
    }

    private static void head(OutputStream out, int code, String type, long length, boolean cache) throws Exception {
        String reason = code == 200 ? " OK" : code == 204 ? " No Content" : code == 403 ? " Forbidden" : " Not Found";
        String head = "HTTP/1.1 " + code + reason + "\r\n" +
                "Content-Type: " + type + "\r\n" +
                "Content-Length: " + length + "\r\n" +
                "X-Content-Type-Options: nosniff\r\n" +
                "Cache-Control: " + (cache ? "max-age=86400" : "no-store") + "\r\n" +
                "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
    }
}
