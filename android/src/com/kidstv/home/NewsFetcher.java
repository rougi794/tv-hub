package com.kidstv.home;

import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * News ticker headlines, fetched by the app itself (no CORS, no third-party proxy).
 * rss2json.com, used before, now answers 403 to every request (2026-10-21).
 *
 * Only the feeds listed in data/news_sources.json are fetched — the request carries no URL (no SSRF).
 * RSS <item><title> and Atom <entry><title> are read; a source that fails or times out is skipped.
 * Results are cached for CACHE_MS so page reloads do not hit the news sites.
 */
final class NewsFetcher {
    private static final long CACHE_MS = 10 * 60 * 1000;
    private static final int TIMEOUT_MS = 8000;
    private static final int MAX_BYTES = 2 * 1024 * 1024;
    private static final int MAX_SOURCES = 12;

    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private JSONObject cached;
    private long cachedAt;
    private int cachedLimit;

    /** {"items":[{"title","source"}], "ok":["name"], "failed":["name"]} — failed sources are listed for diagnosis. */
    synchronized JSONObject get(File webRoot, int limitPerSource) throws Exception {
        long now = System.currentTimeMillis();
        if (cached != null && cachedLimit == limitPerSource && now - cachedAt < CACHE_MS) return cached;

        JSONArray sources = readSources(webRoot);
        List<Future<List<String>>> jobs = new ArrayList<>();
        List<String> names = new ArrayList<>();
        for (int i = 0; i < sources.length() && jobs.size() < MAX_SOURCES; i++) {
            JSONObject s = sources.optJSONObject(i);
            if (s == null) continue;
            final String url = s.optString("url", "").trim();
            if (!url.startsWith("https://") && !url.startsWith("http://")) continue;
            names.add(s.optString("name", url));
            jobs.add(pool.submit(() -> titles(url, limitPerSource)));
        }

        JSONArray items = new JSONArray(), ok = new JSONArray(), failed = new JSONArray();
        for (int i = 0; i < jobs.size(); i++) {
            List<String> t = null;
            try { t = jobs.get(i).get(TIMEOUT_MS + 4000, TimeUnit.MILLISECONDS); } catch (Exception e) { jobs.get(i).cancel(true); }
            if (t == null || t.isEmpty()) { failed.put(names.get(i)); continue; }
            ok.put(names.get(i));
            for (String title : t) items.put(new JSONObject().put("title", title).put("source", names.get(i)));
        }
        JSONObject result = new JSONObject().put("items", items).put("ok", ok).put("failed", failed);
        if (items.length() > 0) { cached = result; cachedAt = now; cachedLimit = limitPerSource; }
        android.util.Log.i(HomeActivity.TAG, "news: " + items.length() + " titles, ok=" + ok + " failed=" + failed);
        return result;
    }

    private static JSONArray readSources(File webRoot) {
        if (webRoot == null) return new JSONArray();
        try (FileInputStream in = new FileInputStream(new File(webRoot, "data/news_sources.json"))) {
            return new JSONArray(new String(readAll(in, MAX_BYTES), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private static List<String> titles(String feedUrl, int limit) {
        List<String> out = new ArrayList<>();
        try {
            byte[] body = download(feedUrl);
            if (body == null) return out;
            XmlPullParser p = Xml.newPullParser();
            p.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false);
            p.setInput(new ByteArrayInputStream(body), null);
            boolean inItem = false;
            for (int ev = p.getEventType(); ev != XmlPullParser.END_DOCUMENT && out.size() < limit; ev = p.next()) {
                if (ev == XmlPullParser.START_TAG) {
                    String n = p.getName().toLowerCase(Locale.ROOT);
                    if (n.equals("item") || n.equals("entry")) inItem = true;
                    else if (inItem && n.equals("title")) {
                        String t = clean(p.nextText());
                        if (!t.isEmpty() && !out.contains(t)) out.add(t);
                    }
                } else if (ev == XmlPullParser.END_TAG) {
                    String n = p.getName().toLowerCase(Locale.ROOT);
                    if (n.equals("item") || n.equals("entry")) inItem = false;
                }
            }
        } catch (Exception e) {
            android.util.Log.w(HomeActivity.TAG, "news source failed: " + feedUrl + " " + e.getClass().getSimpleName());
        }
        return out;
    }

    /** GET with a browser-like User-Agent; follows up to 4 redirects (http/https only). */
    private static byte[] download(String url) throws Exception {
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setInstanceFollowRedirects(false);
            c.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android) TVHub-News");
            c.setRequestProperty("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml, */*");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) {
                String loc = c.getHeaderField("Location");
                c.disconnect();
                if (loc == null) return null;
                url = new URL(new URL(url), loc).toString();
                if (!url.startsWith("https://") && !url.startsWith("http://")) return null;
                continue;
            }
            if (code != 200) { c.disconnect(); return null; }
            try (InputStream in = c.getInputStream()) { return readAll(in, MAX_BYTES); } finally { c.disconnect(); }
        }
        return null;
    }

    private static byte[] readAll(InputStream in, int max) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            b.write(buf, 0, n);
            if (b.size() > max) throw new Exception("too large");
        }
        return b.toByteArray();
    }

    /** Strip CDATA leftovers / tags / entities-as-text and collapse whitespace. */
    private static String clean(String s) {
        if (s == null) return "";
        s = s.replaceAll("<[^>]*>", " ").replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'");
        return s.replaceAll("\\s+", " ").trim();
    }
}
