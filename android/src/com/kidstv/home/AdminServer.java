package com.kidstv.home;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.Locale;
import java.util.Map;

/**
 * LAN admin server for the owner's phone (port 8080, all interfaces).
 * Serves only the admin pages, their bundles and an allow-list of data files; never config.json or wifi.json.
 *
 * Access (AUDIT S4/S5, phase 3): login with the admin password returns a session cookie (HttpOnly, SameSite=Strict,
 * 12 h); data files, pictures and every write need that session (X-Admin-Pass still works for scripts).
 * Public without login: the admin page and its bundles, icons, /api/admin/status|session|login|setpass.
 * Requests whose Host is not an IP address are refused (DNS rebinding), and every reply carries security headers.
 * At most 8 requests are handled at once; files are streamed, never loaded whole into memory (AUDIT R1).
 *
 *   GET  /                        -> admin.html (one page for both interfaces)
 *   GET  /admin.html, /assets/*, /icons/*, /user_icons/*, /channel_icons/*
 *   GET  /data/NAME               -> only the files in READABLE
 *   GET  /api/hub/icon?pkg=P      -> app banner/icon PNG (same path the TV page uses for quick links)
 *   GET  /api/apps                -> installed apps [{pkg,label}]               (password)
 *   GET  /api/kids                -> ["pkg", ...] apps shown to the child         (password)
 *   POST /api/kids                -> body "pkg1,pkg2" (in order)                  (password)
 *   GET  /api/file/list?dir=D     -> [{name}] of today_images/ or user_icons/    (password)
 *   POST /api/file/write?dir=D&name=N -> body = file. data/: JSON files in WRITABLE (<= 1MB);
 *                                    today_images/, user_icons/: jpg/png/webp (<= 25MB)  (password)
 *   POST /api/file/delete?dir=D&name=N -> today_images/ or user_icons/ only          (password)
 *   GET  /api/backup/images.zip   -> every photo and icon + images.json, as one zip       (password)
 * Photos (today_images/, user_icons/) are kept in the app-private folder (LauncherService.mediaDir) and JPEG
 * metadata (GPS position) is removed from every upload.
 *   GET  /data/images.json        -> { "images": [...] }
 *   GET  /today_images/NAME       -> image file
 *   GET  /api/admin/status        -> {"set":bool,"pinSet":bool,"mode":"home"|"kids","lockedFor":ms}
 *   POST /api/admin/setpass       -> first time: X-Admin-New + X-Owner-Pin (the TV owner PIN, if one exists);
 *                                    later X-Admin-New + X-Admin-Pass (old)
 *   POST /api/admin/login         -> {"ok":bool} + session cookie
 *   GET  /api/admin/session       -> {"ok":bool} is the session cookie still valid
 *   POST /api/admin/logout        -> ends the session
 *   POST /api/images?name=N       -> body = image bytes (jpg/png/webp, <= 25MB); appended to images.json
 *   POST /api/images/delete?name=N
 *   POST /api/images/rescan       -> rebuild images.json from today_images/
 *   GET  /data/playlists.json     -> { "updatedAt", "playlists": [{id,name}] } (extra YouTube playlists)
 *   POST /api/playlists           -> body {"playlists":[...]}; saves and bumps updatedAt
 *   POST /api/youtube/refresh     -> bumps updatedAt so the TV re-fetches all playlists
 *   GET  /api/config              -> streaming servers, playlist id, and whether account/key are set (no secrets)
 *   POST /api/config              -> body: changes (StreamConfig.merge); saves config.json, keeps config.json.bak
 *   POST /api/config/test         -> same body, nothing saved: tries every server and the YouTube key
 */
class AdminServer implements Runnable {
    static final int PORT = 8080;
    private static final long MAX_UPLOAD = 25L * 1024 * 1024;
    private static final int MAX_FAILS = 5;
    private static final long LOCK_MS = 60_000;

    private static final long MAX_JSON = 1024 * 1024;
    /** data/ files the phone may read, and the subset it may replace. */
    private static final Set<String> READABLE = new HashSet<>(Arrays.asList(
            "meals.json", "images.json", "reminders.json", "motd.json", "quicklinks.json", "playlists.json",
            "channels.json", "installed_apps.json", "schedule.json"));
    private static final Set<String> WRITABLE = new HashSet<>(Arrays.asList(
            "meals.json", "images.json", "reminders.json", "motd.json", "quicklinks.json", "playlists.json", "channels.json",
            "schedule.json"));
    private static final Set<String> MEDIA_DIRS = new HashSet<>(Arrays.asList("today_images", "user_icons"));
    private static final Set<String> STATIC_DIRS = new HashSet<>(Arrays.asList("assets", "icons", "user_icons", "today_images", "channel_icons"));
    /** Needed before login (the admin page itself and generic icons); family pictures are not among them. */
    private static final Set<String> PUBLIC_DIRS = new HashSet<>(Arrays.asList("assets", "icons", "channel_icons"));

    private final LauncherService ctx;
    // folders come from LauncherService each time (the storage may be mounted after start, AUDIT L5)
    private File root() { return ctx.webRoot(); }
    private File imagesDir() { return ctx.mediaDir("today_images"); }
    /** today_images / user_icons: the app-private folder; everything else: the web folder. */
    private File dirOf(String dir) { return MEDIA_DIRS.contains(dir) ? ctx.mediaDir(dir) : new File(root(), dir); }
    private File imagesJson() { return new File(root(), "data/images.json"); }
    private File playlistsJson() { return new File(root(), "data/playlists.json"); }
    private ServerSocket server;
    private final Lockout passLock;     // phone admin password tries (AUDIT S2)
    private static final long SESSION_MS = 12L * 3600 * 1000;
    private static final int MAX_SESSIONS = 20;
    private final java.util.concurrent.ConcurrentHashMap<String, Long> sessions = new java.util.concurrent.ConcurrentHashMap<>();
    private final java.security.SecureRandom random = new java.security.SecureRandom();
    private final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(8);

    AdminServer(LauncherService ctx) {
        this.ctx = ctx;
        this.passLock = new Lockout(ctx.getSharedPreferences("kids", Context.MODE_PRIVATE), "adminPass", 15);
    }

    void close() {
        try { if (server != null) server.close(); } catch (Exception ignored) { }
        pool.shutdownNow();
    }

    /** Ends every phone session (password changed or reset from the TV). */
    void clearSessions() { sessions.clear(); }

    @Override
    public void run() {
        try {
            server = new ServerSocket(PORT, 16);
            while (!server.isClosed()) {
                final Socket s = server.accept();
                pool.execute(() -> handle(s));            // bounded: at most 8 at once, the rest wait (AUDIT R1)
            }
        } catch (Exception ignored) {
            // closed on destroy or port busy
        }
    }

    // ---------------- request parsing (raw stream: headers + optional body) ----------------
    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 8192) throw new Exception("header too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("UTF-8");
    }

    private void handle(Socket s) {
        try {
            s.setSoTimeout(15000);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            String line = readLine(in);
            String who = String.valueOf(s.getInetAddress()).replace("/", "");
            if (line == null) { android.util.Log.i(HomeActivity.TAG, "admin " + who + " closed without a request"); s.close(); return; }
            // access log for diagnosing phone connections: address + request line only (passwords are in headers)
            android.util.Log.i(HomeActivity.TAG, "admin " + who + " " + line.replaceAll(" HTTP/.*$", ""));
            Map<String, String> headers = new HashMap<>();
            String h;
            int count = 0;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                if (++count > 60) throw new Exception("too many headers");
                int i = h.indexOf(':');
                if (i > 0) headers.put(h.substring(0, i).trim().toLowerCase(Locale.ROOT), h.substring(i + 1).trim());
            }
            String[] p = line.split(" ");
            String method = p.length > 0 ? p[0] : "GET";
            String target = p.length > 1 ? p[1] : "/";
            String path = target, query = "";
            int q = target.indexOf('?');
            if (q >= 0) { path = target.substring(0, q); query = target.substring(q + 1); }
            path = URLDecoder.decode(path, "UTF-8");
            Map<String, String> params = parseQuery(query);
            // The body is read through a stream bounded by Content-Length. Whatever a route left unread
            // (refused or rejected request) is skipped before closing; closing with unread data makes the
            // socket send a reset and the phone sees a network error instead of the 401 / error reply.
            Body body = new Body(in, Math.max(0, contentLength(headers)));
            if (!ipHost(headers.get("host"))) {
                // DNS rebinding: a web page on another name pointed at this IP would see the admin as same-origin
                send(out, 421, "text/plain", "use the TV's IP address".getBytes(StandardCharsets.UTF_8));
            } else {
                route(method, path, params, headers, body, out);
            }
            out.flush();
            body.drain(MAX_UPLOAD + MAX_JSON);
            s.close();
        } catch (Exception e) {
            android.util.Log.w(HomeActivity.TAG, "admin request failed: " + e);
            try { s.close(); } catch (Exception ignored) { }
        }
    }

    private static Map<String, String> parseQuery(String q) throws Exception {
        Map<String, String> m = new HashMap<>();
        for (String kv : q.split("&")) {
            if (kv.isEmpty()) continue;
            int i = kv.indexOf('=');
            String k = i < 0 ? kv : kv.substring(0, i), v = i < 0 ? "" : kv.substring(i + 1);
            m.put(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"));
        }
        return m;
    }

    // ---------------- routes ----------------
    private void route(String method, String path, Map<String, String> params, Map<String, String> headers,
                       InputStream in, OutputStream out) throws Exception {
        String pass = secret(headers, "x-admin-pass");
        String token = sessionToken(headers);
        // logged in = valid session cookie, or the password header (scripts); the password is checked once per request
        boolean passOk = pass != null && checkPass(pass);
        boolean authed = passOk || validSession(token);
        if ("GET".equals(method)) {
            if (path.equals("/") || path.equals("/admin") || path.equals("/admin.html")) { file(out, new File(root(), "admin.html")); return; }
            String[] seg = path.split("/");
            boolean publicDir = seg.length == 3 && PUBLIC_DIRS.contains(seg[1]);
            if (publicDir && safeName(seg[2])) { file(out, new File(root(), seg[1] + "/" + seg[2])); return; }
            if (path.equals("/api/admin/session")) {
                JSONObject j = new JSONObject().put("ok", authed);
                if (authed) j.put("mode", ctx.mode());
                json(out, j);
                return;
            }
            boolean needsLogin = path.startsWith("/data/") || path.startsWith("/api/apps") || path.startsWith("/api/file/")
                    || path.startsWith("/api/kids") || path.startsWith("/api/backup/") || path.equals("/api/config") || (seg.length == 3 && STATIC_DIRS.contains(seg[1]));
            if (needsLogin && !authed) { unauthorized(out); return; }
            if (path.equals("/data/images.json")) { json(out, readImages()); return; }
            if (path.equals("/data/playlists.json")) { json(out, readJson(playlistsJson(), "playlists")); return; }
            if (path.startsWith("/data/")) {
                String name = path.substring("/data/".length());
                if (READABLE.contains(name)) { file(out, new File(root(), "data/" + name)); return; }
            }
            if (seg.length == 3 && STATIC_DIRS.contains(seg[1]) && safeName(seg[2])) { file(out, new File(dirOf(seg[1]), seg[2])); return; }
            if (path.equals("/api/backup/images.zip")) { zipPhotos(out); return; }
            if (path.equals("/api/config")) {
                JSONObject cfg;
                synchronized (LauncherService.DATA_LOCK) { cfg = StreamConfig.read(ctx.configFile()); }
                json(out, StreamConfig.view(cfg).put("ok", true));
                return;
            }
            if (path.equals("/api/hub/icon")) {
                byte[] png = ctx.iconPng(params.get("pkg"));
                if (png == null) send(out, 404, "text/plain", new byte[0]); else send(out, 200, "image/png", png);
                return;
            }
            if (path.equals("/api/admin/status")) {
                // only what the login screen needs (AUDIT-2 N9); the interface is told after login (session / login)
                boolean set = prefs().contains("adminPass");
                JSONObject j = new JSONObject().put("set", set).put("lockedFor", lockLeft());
                if (!set) j.put("pinSet", ctx.pinIsSet());                     // first-time setup asks for the owner PIN
                json(out, j);
                return;
            }
            if (path.equals("/api/apps") || path.equals("/api/file/list") || path.equals("/api/kids")) {
                JSONArray arr = new JSONArray();
                if (path.equals("/api/kids")) {
                    for (String p : ctx.kidsSet()) arr.put(p);
                } else if (path.equals("/api/apps")) {
                    for (Map.Entry<String, String> e : ctx.launchableApps().entrySet())
                        arr.put(new JSONObject().put("pkg", e.getKey()).put("label", e.getValue()));
                } else {
                    String dir = params.get("dir");
                    File[] files = MEDIA_DIRS.contains(dir) ? ctx.mediaDir(dir).listFiles() : null;
                    if (files != null) {
                        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
                        for (File f : files) if (f.isFile() && safeName(f.getName())) arr.put(new JSONObject().put("name", f.getName()));
                    }
                }
                send(out, 200, "application/json; charset=utf-8", arr.toString().getBytes(StandardCharsets.UTF_8));
                return;
            }
            send(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (!"POST".equals(method)) { send(out, 405, "text/plain", new byte[0]); return; }

        switch (path) {
            case "/api/admin/setpass": {
                String nw = secret(headers, "x-admin-new");
                boolean valid = nw != null && nw.length() >= 8 && nw.length() <= 64;   // AUDIT S2: at least 8
                boolean allowed;
                // changing it needs the CURRENT password typed again (a stolen session alone cannot take the account)
                if (prefs().contains("adminPass")) allowed = passOk;
                else allowed = !ctx.pinIsSet() || ctx.checkOwnerPin(secret(headers, "x-owner-pin"));   // no first-come takeover
                boolean ok = valid && allowed;
                if (ok) {
                    prefs().edit().putString("adminPass", Secrets.hash(nw)).commit();   // hash, never the text (N2)
                    ctx.secretsChanged();
                    sessions.clear();                                    // other phones must log in again
                    json(out, new JSONObject().put("ok", true), sessionCookie(newSession()));
                } else {
                    json(out, new JSONObject().put("ok", false));
                }
                return;
            }
            case "/api/admin/login": {
                boolean ok = passOk;
                if (ok) json(out, new JSONObject().put("ok", true).put("lockedFor", 0).put("mode", ctx.mode()), sessionCookie(newSession()));
                else json(out, new JSONObject().put("ok", false).put("lockedFor", lockLeft()));
                return;
            }
            case "/api/admin/logout":
                if (token != null) sessions.remove(token);
                json(out, new JSONObject().put("ok", true), "hub_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
                return;
        }
        if (!authed) { unauthorized(out); return; }

        switch (path) {
            case "/api/file/write": {
                String dir = params.get("dir"), name = params.get("name");
                long len = contentLength(headers);
                if ("data".equals(dir) && WRITABLE.contains(name)) {
                    if (len <= 0 || len > MAX_JSON) { json(out, new JSONObject().put("ok", false).put("error", "size")); return; }
                    byte[] body = readBody(in, (int) len);
                    String text = new String(body, StandardCharsets.UTF_8).trim();
                    try {                                           // reject anything that is not JSON
                        if (text.startsWith("[")) new JSONArray(text); else new JSONObject(text);
                    } catch (Exception e) { json(out, new JSONObject().put("ok", false).put("error", "json")); return; }
                    if ("quicklinks.json".equals(name) && !safeLinks(text)) {
                        json(out, new JSONObject().put("ok", false).put("error", "url")); return;
                    }
                    if ("channels.json".equals(name) && !LauncherService.validChannels(text)) {
                        json(out, new JSONObject().put("ok", false).put("error", "channel")); return;
                    }
                    if ("reminders.json".equals(name) && !Reminders.valid(text)) {
                        json(out, new JSONObject().put("ok", false).put("error", "reminder")); return;
                    }
                    writeBytes(new File(root(), "data/" + name), body);
                    if ("reminders.json".equals(name)) Reminders.schedule(ctx);   // the next alarm follows the change
                    json(out, new JSONObject().put("ok", true));
                    return;
                }
                if (MEDIA_DIRS.contains(dir) && safeName(name) && isImage(name)) {
                    if (len <= 0 || len > MAX_UPLOAD) { json(out, new JSONObject().put("ok", false).put("error", "size")); return; }
                    File d = ctx.mediaDir(dir);
                    d.mkdirs();
                    File tmp = new File(d, "." + name + ".part");
                    streamTo(in, len, tmp);
                    if (!looksLikeImage(tmp)) { tmp.delete(); json(out, new JSONObject().put("ok", false).put("error", "image")); return; }
                    ImageMeta.stripInPlace(tmp);                   // no GPS position / camera data on the TV
                    if ("today_images".equals(dir)) PhotoScale.limit(tmp);   // at most 1920 px, even if not sent scaled
                    if (!tmp.renameTo(new File(d, name))) { tmp.delete(); json(out, new JSONObject().put("ok", false).put("error", "write")); return; }
                    json(out, new JSONObject().put("ok", true));
                    return;
                }
                json(out, new JSONObject().put("ok", false).put("error", "not allowed"));
                return;
            }
            case "/api/kids": {                          // body: "pkg1,pkg2" (sanitised by saveKids)
                long len = contentLength(headers);
                if (len < 0 || len > 16 * 1024) { json(out, new JSONObject().put("ok", false)); return; }
                ctx.saveKids(new String(readBody(in, (int) len), StandardCharsets.UTF_8));
                json(out, new JSONObject().put("ok", true));
                return;
            }
            case "/api/file/delete": {
                String dir = params.get("dir"), name = params.get("name");
                boolean ok = MEDIA_DIRS.contains(dir) && safeName(name);
                if (ok) new File(ctx.mediaDir(dir), name).delete();
                json(out, new JSONObject().put("ok", ok));
                return;
            }
            case "/api/images": {
                String name = params.get("name");
                long len = contentLength(headers);
                if (!safeName(name) || !isImage(name) || len <= 0 || len > MAX_UPLOAD) {
                    json(out, new JSONObject().put("ok", false).put("error", "invalid")); return;
                }
                imagesDir().mkdirs();
                File tmp = new File(imagesDir(), "." + name + ".part");
                streamTo(in, len, tmp);
                if (!looksLikeImage(tmp)) { tmp.delete(); json(out, new JSONObject().put("ok", false).put("error", "image")); return; }
                ImageMeta.stripInPlace(tmp);
                PhotoScale.limit(tmp);
                File dest = new File(imagesDir(), name);
                if (!tmp.renameTo(dest)) { tmp.delete(); json(out, new JSONObject().put("ok", false).put("error", "write")); return; }
                JSONObject j = readImages();
                JSONArray arr = j.getJSONArray("images");
                boolean exists = false;
                for (int i = 0; i < arr.length(); i++) if (name.equals(arr.optString(i))) exists = true;
                if (!exists) arr.put(name);
                writeImages(j);
                json(out, new JSONObject().put("ok", true).put("images", arr));
                return;
            }
            case "/api/images/delete": {
                String name = params.get("name");
                if (!safeName(name)) { json(out, new JSONObject().put("ok", false)); return; }
                new File(imagesDir(), name).delete();
                JSONObject j = readImages();
                JSONArray arr = j.getJSONArray("images"), next = new JSONArray();
                for (int i = 0; i < arr.length(); i++) if (!name.equals(arr.optString(i))) next.put(arr.optString(i));
                j.put("images", next);
                writeImages(j);
                json(out, new JSONObject().put("ok", true).put("images", next));
                return;
            }
            case "/api/playlists": {                     // body: {"playlists":[{"id":"PL..","name":".."}]}
                long len = contentLength(headers);
                if (len <= 0 || len > 64 * 1024) { json(out, new JSONObject().put("ok", false)); return; }
                byte[] body = readBody(in, (int) len);
                JSONArray src = new JSONObject(new String(body, StandardCharsets.UTF_8)).optJSONArray("playlists");
                JSONArray clean = new JSONArray();
                for (int i = 0; src != null && i < src.length() && clean.length() < 30; i++) {
                    JSONObject p = src.optJSONObject(i);
                    if (p == null || !p.optString("id").matches("[A-Za-z0-9_-]{10,64}")) continue;
                    String name = p.optString("name", "").trim();
                    if (name.length() > 60) name = name.substring(0, 60);
                    clean.put(new JSONObject().put("id", p.optString("id")).put("name", name));
                }
                JSONObject j = new JSONObject().put("playlists", clean).put("updatedAt", String.valueOf(System.currentTimeMillis()));
                writeJson(playlistsJson(), j);
                json(out, new JSONObject().put("ok", true).put("playlists", clean));
                return;
            }
            case "/api/config":
            case "/api/config/test": {                   // streaming account, servers, YouTube key (StreamConfig)
                long len = contentLength(headers);
                if (len <= 0 || len > 16 * 1024) { json(out, new JSONObject().put("ok", false).put("error", "حجم الطلب غير صالح")); return; }
                JSONObject req = new JSONObject(new String(readBody(in, (int) len), StandardCharsets.UTF_8));
                File f = ctx.configFile();
                if (f == null) { json(out, new JSONObject().put("ok", false).put("error", "مجلد الإعدادات غير متاح")); return; }
                JSONObject next;
                try {
                    synchronized (LauncherService.DATA_LOCK) {
                        JSONObject cur = StreamConfig.read(f);
                        next = StreamConfig.merge(cur, req);
                        if (StreamConfig.needsPassword(cur, next, req) && !passOk) {
                            json(out, new JSONObject().put("ok", false).put("needPass", true).put("lockedFor", lockLeft())
                                    .put("error", "تغيير الخوادم يحتاج كلمة مرور صفحة الجوال"));
                            return;
                        }
                        if (path.equals("/api/config")) {
                            if (f.isFile()) writeBytesLocked(new File(f.getPath() + ".bak"), cur.toString(2).getBytes(StandardCharsets.UTF_8));
                            writeBytesLocked(f, next.toString(2).getBytes(StandardCharsets.UTF_8));
                        }
                    }
                } catch (StreamConfig.Invalid e) {
                    json(out, new JSONObject().put("ok", false).put("error", e.getMessage()));
                    return;
                }
                if (path.equals("/api/config/test")) { json(out, StreamConfig.test(next, new File(root(), "data/channels.json")).put("ok", true)); return; }
                // the kids page re-reads config.json on every channel start; YouTube lists are re-fetched on the next check
                JSONObject pl = readJson(playlistsJson(), "playlists");
                pl.put("updatedAt", String.valueOf(System.currentTimeMillis()));
                writeJson(playlistsJson(), pl);
                android.util.Log.i(HomeActivity.TAG, "stream settings saved from the phone");
                json(out, StreamConfig.view(next).put("ok", true));
                return;
            }
            case "/api/youtube/refresh": {               // TV re-fetches on its next 5-minute check
                JSONObject j = readJson(playlistsJson(), "playlists");
                j.put("updatedAt", String.valueOf(System.currentTimeMillis()));
                writeJson(playlistsJson(), j);
                json(out, new JSONObject().put("ok", true));
                return;
            }
            case "/api/images/rescan": {
                File[] files = imagesDir().listFiles();
                JSONArray arr = new JSONArray();
                if (files != null) {
                    Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
                    for (File f : files) if (f.isFile() && safeName(f.getName()) && isImage(f.getName())) arr.put(f.getName());
                }
                JSONObject j = new JSONObject().put("images", arr);
                writeImages(j);
                json(out, new JSONObject().put("ok", true).put("images", arr));
                return;
            }
            default:
                send(out, 404, "text/plain", new byte[0]);
        }
    }

    // ---------------- helpers ----------------
    private SharedPreferences prefs() { return ctx.getSharedPreferences("kids", Context.MODE_PRIVATE); }

    private void unauthorized(OutputStream out) throws Exception {
        send(out, 401, "application/json", "{\"ok\":false,\"error\":\"auth\"}".getBytes(StandardCharsets.UTF_8));
    }

    /** Request body limited to Content-Length, so reads never block waiting for bytes the client will not send. */
    private static final class Body extends java.io.FilterInputStream {
        private long left;

        Body(InputStream in, long len) { super(in); left = len; }

        @Override public int read() throws java.io.IOException {
            if (left <= 0) return -1;
            int c = super.read();
            if (c >= 0) left--;
            return c;
        }

        @Override public int read(byte[] b, int off, int len) throws java.io.IOException {
            if (left <= 0) return -1;
            int n = super.read(b, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        void drain(long max) {
            if (left > max) return;                       // too big to be worth reading: just close
            byte[] buf = new byte[16 * 1024];
            try { while (left > 0 && read(buf, 0, buf.length) > 0) { /* discard */ } } catch (Exception ignored) { }
        }
    }

    /**
     * Password/PIN header: the admin page sends it URI-encoded (headers cannot carry Arabic text) and may contain
     * Arabic-Indic digits from an Arabic keyboard; both are normalised so "٢٤٦٨١٣" equals "246813".
     */
    private static String secret(Map<String, String> headers, String name) {
        String v = headers.get(name);
        if (v == null) return null;
        try { v = URLDecoder.decode(v.replace("+", "%2B"), "UTF-8"); } catch (Exception ignored) { /* keep raw */ }
        StringBuilder b = new StringBuilder(v.trim());
        for (int i = 0; i < b.length(); i++) {
            char c = b.charAt(i);
            if (c >= '٠' && c <= '٩') b.setCharAt(i, (char) ('0' + (c - '٠')));
            else if (c >= '۰' && c <= '۹') b.setCharAt(i, (char) ('0' + (c - '۰')));
        }
        return b.toString();
    }

    /** Backup of the photos, which adb cannot read in the app-private folder. Streamed, no Content-Length. */
    private void zipPhotos(OutputStream out) throws Exception {
        String head = "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\n"
                + "Content-Disposition: attachment; filename=\"tv-hub-photos.zip\"\r\n"
                + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(out)) {
            byte[] buf = new byte[64 * 1024];
            for (String dir : LauncherService.MEDIA) {
                File[] files = ctx.mediaDir(dir).listFiles();
                if (files == null) continue;
                for (File f : files) {
                    if (!f.isFile() || f.getName().startsWith(".")) continue;
                    zip.putNextEntry(new java.util.zip.ZipEntry(dir + "/" + f.getName()));
                    try (FileInputStream in = new FileInputStream(f)) { int n; while ((n = in.read(buf)) > 0) zip.write(buf, 0, n); }
                    zip.closeEntry();
                }
            }
            File ij = imagesJson();
            if (ij.isFile()) {
                zip.putNextEntry(new java.util.zip.ZipEntry("data/images.json"));
                try (FileInputStream in = new FileInputStream(ij)) { int n; while ((n = in.read(buf)) > 0) zip.write(buf, 0, n); }
                zip.closeEntry();
            }
        }
    }

    // ---------------- sessions ----------------
    private String newSession() {
        byte[] b = new byte[32];
        random.nextBytes(b);
        StringBuilder t = new StringBuilder();
        for (byte x : b) t.append(String.format("%02x", x));
        long now = System.currentTimeMillis();
        sessions.entrySet().removeIf(e -> e.getValue() < now);
        if (sessions.size() >= MAX_SESSIONS) {                        // keep the newest ones
            String oldest = null;
            for (Map.Entry<String, Long> e : sessions.entrySet()) if (oldest == null || e.getValue() < sessions.get(oldest)) oldest = e.getKey();
            if (oldest != null) sessions.remove(oldest);
        }
        sessions.put(t.toString(), now + SESSION_MS);
        return t.toString();
    }

    private static String sessionCookie(String token) {
        return "hub_session=" + token + "; Path=/; Max-Age=" + (SESSION_MS / 1000) + "; HttpOnly; SameSite=Strict";
    }

    private static String sessionToken(Map<String, String> headers) {
        String c = headers.get("cookie");
        if (c == null) return null;
        for (String part : c.split(";")) {
            String p = part.trim();
            if (p.startsWith("hub_session=")) return p.substring("hub_session=".length());
        }
        return null;
    }

    /** Valid and not expired; each use extends it (sliding 12 h). */
    private boolean validSession(String token) {
        if (token == null) return false;
        Long until = sessions.get(token);
        long now = System.currentTimeMillis();
        if (until == null || until < now) { if (until != null) sessions.remove(token); return false; }
        sessions.put(token, now + SESSION_MS);
        return true;
    }

    /** Host must be an IP literal (or localhost): blocks DNS-rebinding pages that use their own name for this IP. */
    private static boolean ipHost(String host) {
        if (host == null) return true;                                 // HTTP/1.0 clients without Host
        String h = host.trim().toLowerCase(Locale.ROOT);
        if (h.startsWith("[")) return true;                           // IPv6 literal
        int colon = h.lastIndexOf(':');
        if (colon > 0) h = h.substring(0, colon);
        return h.equals("localhost") || h.matches("\\d{1,3}(\\.\\d{1,3}){3}");
    }

    /** JPEG / PNG / WEBP signature check: an upload named .jpg must really be a picture (AUDIT R2). */
    private static boolean looksLikeImage(File f) {
        byte[] b = new byte[12];
        try (FileInputStream in = new FileInputStream(f)) {
            if (in.read(b) < 12) return false;
        } catch (Exception e) {
            return false;
        }
        boolean jpeg = (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xD8 && (b[2] & 0xff) == 0xFF;
        boolean png = (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G';
        boolean webp = b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P';
        return jpeg || png || webp;
    }

    private static long contentLength(Map<String, String> headers) {
        try { return Long.parseLong(headers.containsKey("content-length") ? headers.get("content-length") : "-1"); }
        catch (NumberFormatException e) { return -1; }
    }

    private static byte[] readBody(InputStream in, int len) throws Exception {
        byte[] body = new byte[len];
        int off = 0, n;
        while (off < len && (n = in.read(body, off, len - off)) > 0) off += n;
        if (off < len) throw new Exception("short body");
        return body;
    }

    private static void streamTo(InputStream in, long len, File dest) throws Exception {
        boolean ok = false;
        try (FileOutputStream fo = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            long left = len;
            while (left > 0) {
                int n = in.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) throw new Exception("short body");
                fo.write(buf, 0, n);
                left -= n;
            }
            ok = true;
        } finally {
            if (!ok) dest.delete();
        }
    }

    /** Atomic replace (tmp + rename), so the TV page never reads a half-written file. */
    private void writeBytes(File f, byte[] body) throws Exception {
        synchronized (LauncherService.DATA_LOCK) { writeBytesLocked(f, body); }
    }

    private static void writeBytesLocked(File f, byte[] body) throws Exception {
        f.getParentFile().mkdirs();
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(body); }
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
    }

    private long lockLeft() { return passLock.lockLeft(); }

    private boolean checkPass(String pass) { return passLock.check(prefs().getString("adminPass", null), pass); }

    /** Every quick link with a url must be http(s): a javascript: link would run inside the TV page (AUDIT S3). */
    private static boolean safeLinks(String text) {
        try {
            JSONArray a = new JSONArray(text);
            for (int i = 0; i < a.length(); i++) {
                JSONObject l = a.optJSONObject(i);
                if (l == null) return false;
                String url = l.optString("url", "");
                if (!url.isEmpty() && !url.toLowerCase(Locale.ROOT).matches("https?://.+")) return false;
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean safeName(String n) {
        return n != null && n.matches("[A-Za-z0-9_.-]{1,80}") && !n.startsWith(".");
    }

    private static boolean isImage(String n) {
        String l = n.toLowerCase(Locale.ROOT);
        return l.endsWith(".jpg") || l.endsWith(".jpeg") || l.endsWith(".png") || l.endsWith(".webp");
    }

    private JSONObject readImages() { return readJson(imagesJson(), "images"); }

    private void writeImages(JSONObject j) throws Exception { writeJson(imagesJson(), j); }

    private JSONObject readJson(File f, String arrayKey) {
        synchronized (LauncherService.DATA_LOCK) { return readJsonLocked(f, arrayKey); }
    }

    private static JSONObject readJsonLocked(File f, String arrayKey) {
        try (FileInputStream fi = new FileInputStream(f)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fi.read(buf)) > 0) b.write(buf, 0, n);
            JSONObject j = new JSONObject(b.toString("UTF-8"));
            if (!j.has(arrayKey)) j.put(arrayKey, new JSONArray());
            return j;
        } catch (Exception e) {
            try { return new JSONObject().put(arrayKey, new JSONArray()); } catch (Exception x) { return new JSONObject(); }
        }
    }

    private void writeJson(File f, JSONObject j) throws Exception {
        synchronized (LauncherService.DATA_LOCK) { writeJsonLocked(f, j); }
    }

    private static void writeJsonLocked(File f, JSONObject j) throws Exception {
        f.getParentFile().mkdirs();
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream fo = new FileOutputStream(tmp)) { fo.write(j.toString(2).getBytes(StandardCharsets.UTF_8)); }
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f); }
    }

    /** Streams the file in 64 KB pieces (a 25 MB picture is never held in memory, AUDIT R1). */
    private void file(OutputStream out, File f) throws Exception {
        if (!f.isFile()) { send(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8)); return; }
        String l = f.getName().toLowerCase(Locale.ROOT);
        head(out, 200, l.endsWith(".jpg") || l.endsWith(".jpeg") ? "image/jpeg" : LauncherService.mime(l), f.length(), null);
        try (FileInputStream fi = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = fi.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void json(OutputStream out, JSONObject o) throws Exception { json(out, o, null); }

    private void json(OutputStream out, JSONObject o, String setCookie) throws Exception {
        byte[] b = o.toString().getBytes(StandardCharsets.UTF_8);
        head(out, 200, "application/json; charset=utf-8", b.length, setCookie);
        out.write(b);
    }

    private void send(OutputStream out, int code, String type, byte[] body) throws Exception {
        head(out, code, type, body.length, null);
        out.write(body);
    }

    private static void head(OutputStream out, int code, String type, long length, String setCookie) throws Exception {
        String reason = code == 200 ? "OK" : code == 401 ? "Unauthorized" : code == 404 ? "Not Found"
                : code == 421 ? "Misdirected Request" : "Error";
        String head = "HTTP/1.1 " + code + " " + reason + "\r\n" +
                "Content-Type: " + type + "\r\n" +
                "Content-Length: " + length + "\r\n" +
                "Cache-Control: no-store\r\n" +
                "X-Content-Type-Options: nosniff\r\n" +
                "X-Frame-Options: DENY\r\n" +
                "Content-Security-Policy: frame-ancestors 'none'\r\n" +
                "Referrer-Policy: no-referrer\r\n" +
                (setCookie != null ? "Set-Cookie: " + setCookie + "\r\n" : "") +
                "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.US_ASCII));
    }
}
