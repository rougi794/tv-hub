package com.kidstv.home;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * The streaming and YouTube settings of config.json (private folder), edited from the phone admin.
 *
 * Secrets (provider username/password, YouTube API key) are write-only: the phone sees only whether they are set,
 * never their value, and they are never logged. Every other key of config.json (home dashboard settings, test ids)
 * is kept as it is. Server URLs are shown to the logged-in owner.
 */
final class StreamConfig {
    private static final int MAX_BACKUPS = 8;
    private static final int TIMEOUT_MS = 8000;
    /** The API key is restricted to this referrer in Google Cloud (page origin on the TV). */
    private static final String YT_REFERER = "http://127.0.0.1:8765/kids.html";

    private StreamConfig() { }

    /** Rejected input; `msg` is shown on the phone. */
    static final class Invalid extends Exception {
        Invalid(String msg) { super(msg); }
    }

    static JSONObject read(File f) {
        if (f == null || !f.isFile()) return new JSONObject();
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0 && b.size() < 1024 * 1024) b.write(buf, 0, n);
            String s = new String(b.toByteArray(), StandardCharsets.UTF_8);
            if (s.startsWith("﻿")) s = s.substring(1);
            return new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static JSONObject section(JSONObject cfg, String name) throws Exception {
        JSONObject u = cfg.optJSONObject("userSettings");
        if (u == null) { u = new JSONObject(); cfg.put("userSettings", u); }
        JSONObject s = u.optJSONObject(name);
        if (s == null) { s = new JSONObject(); u.put(name, s); }
        return s;
    }

    /** What the phone may see: URLs, playlist id, and "set" flags for the secrets. */
    static JSONObject view(JSONObject cfg) throws Exception {
        JSONObject st = section(new JSONObject(cfg.toString()), "stream");
        JSONObject yt = section(new JSONObject(cfg.toString()), "youtube");
        JSONArray backups = st.optJSONArray("baseUrls");
        JSONObject sec = section(new JSONObject(cfg.toString()), "security");
        String lock = sec.optString("pinCode", "");
        return new JSONObject()
                // home dashboard lock (4 digits, owner decision 2026-10-22): only whether it is still the default
                .put("lockDefault", lock.isEmpty() || "1234".equals(lock))
                .put("baseUrl", st.optString("baseUrl", ""))
                .put("baseUrls", backups == null ? new JSONArray() : backups)
                .put("credsSet", !st.optString("username", "").isEmpty() && !st.optString("password", "").isEmpty())
                .put("keySet", !yt.optString("apiKey", "").isEmpty())
                .put("playlistId", yt.optString("playlistId", ""));
    }

    private static String base(String v) throws Invalid {
        String s = v == null ? "" : v.trim().replaceAll("/+$", "");
        if (s.isEmpty()) return "";
        if (s.length() > 300 || !s.matches("(?i)https?://[A-Za-z0-9.-]+(:\\d{1,5})?(/[^\\s\"'<>\\\\]*)?"))
            throw new Invalid("عنوان خادم غير صحيح: يجب أن يبدأ بـ http:// أو https://");
        // https on port 80 fails at once (port 80 is plain http); seen with backup addresses copied from the provider
        if (s.matches("(?i)https://[^/]+:80(/.*)?")) throw new Invalid("العنوان " + s + " يستخدم https مع المنفذ 80، والصحيح غالبًا http://");
        return s;
    }

    private static String secret(String v, String what) throws Invalid {
        if (v.length() > 128 || !v.matches("[^\\p{Cntrl}]+")) throw new Invalid(what + " غير صالح");
        return v;
    }

    /**
     * Applies a phone request to a copy of `cfg`. Request fields:
     * baseUrl, baseUrls[], username + password (both, to change), clearCreds, apiKey, clearKey, playlistId,
     * lockCode (the home dashboard's 4-digit lock).
     * An empty or missing secret keeps the stored one.
     */
    static JSONObject merge(JSONObject cfg, JSONObject req) throws Exception {
        JSONObject out = new JSONObject(cfg.toString());
        JSONObject st = section(out, "stream"), yt = section(out, "youtube");

        if (req.has("baseUrl")) st.put("baseUrl", base(req.optString("baseUrl")));
        if (req.has("baseUrls")) {
            JSONArray in = req.optJSONArray("baseUrls"), list = new JSONArray();
            for (int i = 0; in != null && i < in.length(); i++) {
                String b = base(in.optString(i));
                if (!b.isEmpty() && !b.equals(st.optString("baseUrl"))) list.put(b);
            }
            if (list.length() > MAX_BACKUPS) throw new Invalid("حد أقصى " + MAX_BACKUPS + " خوادم احتياطية");
            if (list.length() == 0) st.remove("baseUrls"); else st.put("baseUrls", list);
        }
        if (req.optBoolean("clearCreds", false)) {
            st.remove("username");
            st.remove("password");
        } else {
            String user = req.optString("username", ""), pass = req.optString("password", "");
            if (!user.isEmpty() || !pass.isEmpty()) {
                if (user.isEmpty() || pass.isEmpty()) throw new Invalid("أدخل اسم المستخدم وكلمة المرور معًا");
                st.put("username", secret(user, "اسم المستخدم"));
                st.put("password", secret(pass, "كلمة المرور"));
            }
        }
        if (req.optBoolean("clearKey", false)) {
            yt.remove("apiKey");
        } else {
            String key = req.optString("apiKey", "").trim();
            if (!key.isEmpty()) {
                if (!key.matches("[A-Za-z0-9_-]{30,60}")) throw new Invalid("مفتاح يوتيوب غير صحيح");
                yt.put("apiKey", key);
            }
        }
        String lock = req.optString("lockCode", "").trim();
        if (!lock.isEmpty()) {
            if (!lock.matches("\\d{4}")) throw new Invalid("رمز قفل اللوحة 4 أرقام");
            section(out, "security").put("pinCode", lock);
        }
        if (req.has("playlistId")) {
            String pl = req.optString("playlistId", "").trim();
            if (!pl.isEmpty() && !pl.matches("[A-Za-z0-9_-]{10,64}")) throw new Invalid("رقم قائمة يوتيوب غير صحيح");
            if (pl.isEmpty()) yt.remove("playlistId"); else yt.put("playlistId", pl);
        }
        return out;
    }

    /** Main + backup servers in order. */
    static List<String> servers(JSONObject cfg) {
        List<String> out = new ArrayList<>();
        try {
            JSONObject st = section(new JSONObject(cfg.toString()), "stream");
            if (!st.optString("baseUrl").isEmpty()) out.add(st.optString("baseUrl"));
            JSONArray b = st.optJSONArray("baseUrls");
            for (int i = 0; b != null && i < b.length(); i++) out.add(b.optString(i));
        } catch (Exception ignored) { }
        return out;
    }

    static boolean hasAccount(JSONObject cfg) {
        try { return view(cfg).optBoolean("credsSet"); } catch (Exception e) { return false; }
    }

    /**
     * Sending the SAVED account to servers that are not the saved ones (test or save) needs the phone admin password
     * (AUDIT-3 S3): otherwise a session alone could point the TV at another server and receive the account.
     * Not needed when the request brings its own account, or when the servers do not change.
     */
    static boolean needsPassword(JSONObject cur, JSONObject next, JSONObject req) {
        boolean ownAccount = !req.optString("username", "").isEmpty() && !req.optString("password", "").isEmpty();
        if (ownAccount || req.optBoolean("clearCreds", false) || !hasAccount(cur)) return false;
        return !servers(cur).containsAll(servers(next));
    }

    // ---------------- connection test (nothing is saved) ----------------

    /**
     * Tries every server with the stored/new account, and the YouTube key. Result (no secrets):
     * {"servers":[{"base","ok","ms","note"}], "youtube":{"ok","note"}}
     */
    static JSONObject test(JSONObject cfg, File channelsJson) throws Exception {
        JSONObject st = section(new JSONObject(cfg.toString()), "stream");
        JSONObject yt = section(new JSONObject(cfg.toString()), "youtube");
        List<String> bases = new ArrayList<>();
        if (!st.optString("baseUrl").isEmpty()) bases.add(st.optString("baseUrl"));
        JSONArray b = st.optJSONArray("baseUrls");
        for (int i = 0; b != null && i < b.length(); i++) if (!bases.contains(b.optString(i))) bases.add(b.optString(i));
        String user = st.optString("username", ""), pass = st.optString("password", "");
        String channel = firstChannelId(channelsJson);

        ExecutorService pool = Executors.newFixedThreadPool(Math.max(1, Math.min(bases.size() + 1, 6)));
        try {
            List<Future<JSONObject>> jobs = new ArrayList<>();
            for (String base : bases) jobs.add(pool.submit(() -> testServer(base, user, pass, channel)));
            String key = yt.optString("apiKey", ""), pl = yt.optString("playlistId", "");
            Future<JSONObject> ytJob = pool.submit(() -> testYouTube(key, pl));
            JSONArray servers = new JSONArray();
            for (int i = 0; i < jobs.size(); i++) {
                JSONObject r;
                try { r = jobs.get(i).get(TIMEOUT_MS * 3L, TimeUnit.MILLISECONDS); }
                catch (Exception e) { r = new JSONObject().put("ok", false).put("note", "لا يستجيب"); }
                servers.put(r.put("base", bases.get(i)));
            }
            JSONObject y;
            try { y = ytJob.get(TIMEOUT_MS * 2L, TimeUnit.MILLISECONDS); }
            catch (Exception e) { y = new JSONObject().put("ok", false).put("note", "لا يستجيب"); }
            return new JSONObject().put("servers", servers).put("youtube", y);
        } finally {
            pool.shutdownNow();
        }
    }

    private static String firstChannelId(File channelsJson) {
        JSONArray ch = read(channelsJson).optJSONArray("channels");
        for (int i = 0; ch != null && i < ch.length(); i++) {
            JSONObject c = ch.optJSONObject(i);
            if (c != null && c.optString("id").matches("\\d{1,10}")) return c.optString("id");
        }
        return null;
    }

    /** Xtream-style panels answer player_api.php with the account state; otherwise one channel playlist is fetched. */
    private static JSONObject testServer(String base, String user, String pass, String channel) throws Exception {
        long t0 = System.currentTimeMillis();
        JSONObject r = new JSONObject();
        if (user.isEmpty() || pass.isEmpty()) return r.put("ok", false).put("note", "لا توجد بيانات دخول محفوظة");
        String q = "username=" + URLEncoder.encode(user, "UTF-8") + "&password=" + URLEncoder.encode(pass, "UTF-8");
        try {
            Resp a = get(base + "/player_api.php?" + q, null, 64 * 1024);
            r.put("ms", System.currentTimeMillis() - t0);
            if (a.code == 200 && a.body.trim().startsWith("{")) {
                JSONObject info = new JSONObject(a.body).optJSONObject("user_info");
                if (info != null) {
                    if (info.optInt("auth", 0) != 1) return r.put("ok", false).put("note", "الخادم رفض اسم المستخدم أو كلمة المرور");
                    String status = info.optString("status", "");
                    String note = "يعمل";
                    long exp = info.optLong("exp_date", 0);
                    if (exp > 0) note += " · الاشتراك حتى " + new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.ROOT).format(new java.util.Date(exp * 1000));
                    if (!status.isEmpty() && !"Active".equalsIgnoreCase(status)) return r.put("ok", false).put("note", "الحساب: " + status);
                    return r.put("ok", true).put("note", note);
                }
            }
            if (channel == null) return r.put("ok", a.code < 500).put("note", "الخادم يجيب (HTTP " + a.code + ")");
            Resp m = get(base + "/live/" + URLEncoder.encode(user, "UTF-8") + "/" + URLEncoder.encode(pass, "UTF-8") + "/" + channel + ".m3u8", null, 16 * 1024);
            r.put("ms", System.currentTimeMillis() - t0);
            if (m.code == 200 && m.body.startsWith("#EXTM3U")) return r.put("ok", true).put("note", "يعمل (قناة " + channel + ")");
            return r.put("ok", false).put("note", m.code == 401 || m.code == 403 ? "الخادم رفض الدخول (HTTP " + m.code + ")" : "HTTP " + m.code);
        } catch (java.net.SocketTimeoutException e) {
            return r.put("ok", false).put("note", "لا يستجيب");
        } catch (java.net.UnknownHostException e) {
            return r.put("ok", false).put("note", "اسم الخادم غير موجود");
        } catch (Exception e) {
            return r.put("ok", false).put("note", "تعذر الاتصال");
        }
    }

    private static JSONObject testYouTube(String key, String playlist) throws Exception {
        JSONObject r = new JSONObject();
        if (key.isEmpty()) return r.put("ok", false).put("note", "لا يوجد مفتاح (فيديوهات يوتيوب لن تظهر)");
        // with a main playlist: checks key and list together; without: a request that needs only the key (1 unit)
        String q = playlist.isEmpty() ? "i18nLanguages?part=snippet&hl=ar"
                : "playlistItems?part=id&maxResults=1&playlistId=" + URLEncoder.encode(playlist, "UTF-8");
        try {
            Resp a = get("https://www.googleapis.com/youtube/v3/" + q + "&key=" + URLEncoder.encode(key, "UTF-8"), YT_REFERER, 64 * 1024);
            if (a.code == 200) return r.put("ok", true).put("note", "المفتاح يعمل");
            String reason = "";
            try { reason = new JSONObject(a.body).getJSONObject("error").getJSONArray("errors").getJSONObject(0).optString("reason"); } catch (Exception ignored) { }
            if (a.code == 404 && !playlist.isEmpty()) return r.put("ok", true).put("note", "المفتاح يعمل، لكن القائمة الرئيسية غير موجودة");
            if (reason.contains("quota")) return r.put("ok", false).put("note", "المفتاح يعمل لكن الحصة اليومية انتهت");
            if (reason.contains("keyInvalid") || a.code == 400) return r.put("ok", false).put("note", "المفتاح غير صحيح");
            if (a.code == 403) return r.put("ok", false).put("note", "المفتاح مرفوض (قيود المفتاح أو الخدمة غير مفعلة)");
            return r.put("ok", false).put("note", "HTTP " + a.code);
        } catch (Exception e) {
            return r.put("ok", false).put("note", "تعذر الوصول إلى يوتيوب");
        }
    }

    private static final class Resp {
        int code;
        String body = "";
    }

    /** GET, following up to 3 redirects (also http <-> https), reading at most `max` bytes. */
    private static Resp get(String url, String referer, int max) throws Exception {
        for (int hop = 0; hop < 4; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) TVHub");
            if (referer != null) c.setRequestProperty("Referer", referer);
            try {
                int code = c.getResponseCode();
                String loc = c.getHeaderField("Location");
                if (code >= 300 && code < 400 && loc != null) {
                    URL next = new URL(new URL(url), loc);
                    if (!next.getProtocol().startsWith("http")) break;
                    url = next.toString();
                    continue;
                }
                Resp r = new Resp();
                r.code = code;
                InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
                if (in != null) {
                    try (InputStream s = in) {
                        ByteArrayOutputStream b = new ByteArrayOutputStream();
                        byte[] buf = new byte[8192];
                        int n;
                        while (b.size() < max && (n = s.read(buf)) > 0) b.write(buf, 0, n);
                        r.body = new String(b.toByteArray(), StandardCharsets.UTF_8);
                    }
                }
                return r;
            } finally {
                c.disconnect();
            }
        }
        Resp r = new Resp();
        r.code = 310;
        return r;
    }
}
