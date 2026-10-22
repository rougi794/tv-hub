package com.kidstv.home;

import com.sun.net.httpserver.HttpServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * JVM test of the phone settings logic (no TV needed). org.json from the Gradle cache:
 *   javac -cp <json.jar> -d out ../src/com/kidstv/home/StreamConfig.java StreamConfigTest.java
 *   java  -cp out;<json.jar> com.kidstv.home.StreamConfigTest
 */
public class StreamConfigTest {
    static int fails = 0;
    static void ok(boolean c, String name) { System.out.println((c ? "PASS " : "FAIL ") + name); if (!c) fails++; }

    static boolean invalid(JSONObject cfg, String req) {
        try { StreamConfig.merge(cfg, new JSONObject(req)); return false; } catch (StreamConfig.Invalid e) { return true; } catch (Exception e) { return false; }
    }

    public static void main(String[] a) throws Exception {
        JSONObject cfg = new JSONObject("{\"userSettings\":{\"security\":{\"pinCode\":\"1234\"},"
                + "\"stream\":{\"baseUrl\":\"http://main.example:80\",\"username\":\"USERX\",\"password\":\"PASSX\",\"testStreamIds\":[\"1\"]},"
                + "\"youtube\":{\"apiKey\":\"AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"playlistId\":\"PLaaaaaaaaaaaa\"}}}");

        // --- view: secrets never leave the TV ---
        JSONObject v = StreamConfig.view(cfg);
        String vs = v.toString();
        ok(!vs.contains("USERX") && !vs.contains("PASSX") && !vs.contains("AIza"), "view: no username / password / key");
        ok(v.getBoolean("credsSet") && v.getBoolean("keySet"), "view: set flags");
        ok(v.getString("baseUrl").equals("http://main.example:80"), "view: server shown");

        // --- merge: servers changed, secrets kept, other settings kept ---
        JSONObject m = StreamConfig.merge(cfg, new JSONObject("{\"baseUrl\":\"https://new.example/\",\"baseUrls\":[\"http://b1.example:8080\",\"\",\"https://new.example\"],\"playlistId\":\"PLbbbbbbbbbbbb\"}"));
        JSONObject st = m.getJSONObject("userSettings").getJSONObject("stream");
        ok(st.getString("baseUrl").equals("https://new.example"), "merge: trailing slash removed");
        ok(st.getJSONArray("baseUrls").length() == 1 && st.getJSONArray("baseUrls").getString(0).equals("http://b1.example:8080"), "merge: empty and duplicate backups dropped");
        ok(st.getString("username").equals("USERX") && st.getString("password").equals("PASSX"), "merge: empty secrets keep the saved account");
        ok(m.getJSONObject("userSettings").getJSONObject("youtube").getString("apiKey").startsWith("AIza"), "merge: key kept");
        ok(m.getJSONObject("userSettings").getJSONObject("security").getString("pinCode").equals("1234"), "merge: home settings kept");
        ok(st.getJSONArray("testStreamIds").length() == 1, "merge: unknown keys kept");
        ok(cfg.getJSONObject("userSettings").getJSONObject("stream").getString("baseUrl").equals("http://main.example:80"), "merge: input not modified");

        // --- secrets: change / clear ---
        JSONObject c2 = StreamConfig.merge(cfg, new JSONObject("{\"username\":\"u2\",\"password\":\"p 2!\"}"));
        ok(c2.getJSONObject("userSettings").getJSONObject("stream").getString("password").equals("p 2!"), "merge: account changed");
        JSONObject c3 = StreamConfig.merge(cfg, new JSONObject("{\"clearCreds\":true,\"clearKey\":true}"));
        ok(!c3.getJSONObject("userSettings").getJSONObject("stream").has("username") && !c3.getJSONObject("userSettings").getJSONObject("youtube").has("apiKey"), "merge: clear account and key");
        JSONObject c4 = StreamConfig.merge(new JSONObject(), new JSONObject("{\"baseUrl\":\"http://x.example\"}"));
        ok(c4.getJSONObject("userSettings").getJSONObject("stream").getString("baseUrl").equals("http://x.example"), "merge: works without a config file");

        // --- rejected input ---
        ok(invalid(cfg, "{\"baseUrl\":\"javascript:alert(1)\"}"), "reject: non-http server");
        ok(invalid(cfg, "{\"baseUrl\":\"http://a.example/\\\"<x>\"}"), "reject: quotes / tags in server");
        ok(invalid(cfg, "{\"username\":\"only\"}"), "reject: username without password");
        ok(invalid(cfg, "{\"username\":\"a\\nb\",\"password\":\"p\"}"), "reject: control characters");
        ok(invalid(cfg, "{\"apiKey\":\"short\"}"), "reject: bad YouTube key");
        ok(invalid(cfg, "{\"playlistId\":\"<script>\"}"), "reject: bad playlist id");
        ok(invalid(cfg, "{\"baseUrls\":[\"https://b.example:80\"]}"), "reject: https on port 80");
        JSONArray many = new JSONArray();
        for (int i = 0; i < 9; i++) many.put("http://s" + i + ".example");
        ok(invalid(cfg, new JSONObject().put("baseUrls", many).toString()), "reject: more than 8 backups");

        // --- home dashboard lock code (4 digits) ---
        ok(StreamConfig.view(cfg).getBoolean("lockDefault"), "lock: 1234 is reported as the default");
        JSONObject lk = StreamConfig.merge(cfg, new JSONObject("{\"lockCode\":\"4821\"}"));
        ok(lk.getJSONObject("userSettings").getJSONObject("security").getString("pinCode").equals("4821")
                && !StreamConfig.view(lk).getBoolean("lockDefault") && !StreamConfig.view(lk).toString().contains("4821"), "lock: changed, not shown");
        ok(invalid(cfg, "{\"lockCode\":\"12a4\"}") && invalid(cfg, "{\"lockCode\":\"12345\"}"), "lock: 4 digits only");

        // --- AUDIT-3 S3: the saved account goes to a NEW server only with the password ---
        JSONObject toEvil = StreamConfig.merge(cfg, new JSONObject("{\"baseUrl\":\"http://evil.example\"}"));
        ok(StreamConfig.needsPassword(cfg, toEvil, new JSONObject("{\"baseUrl\":\"http://evil.example\"}")), "S3: new server with saved account needs password");
        JSONObject addBackup = new JSONObject("{\"baseUrls\":[\"http://b2.example\"]}");
        ok(StreamConfig.needsPassword(cfg, StreamConfig.merge(cfg, addBackup), addBackup), "S3: new backup server needs password");
        JSONObject own = new JSONObject("{\"baseUrl\":\"http://evil.example\",\"username\":\"x\",\"password\":\"y\"}");
        ok(!StreamConfig.needsPassword(cfg, StreamConfig.merge(cfg, own), own), "S3: request with its own account needs no password");
        JSONObject same = new JSONObject("{\"baseUrl\":\"http://main.example:80/\",\"playlistId\":\"PLcccccccccccc\"}");
        ok(!StreamConfig.needsPassword(cfg, StreamConfig.merge(cfg, same), same), "S3: same servers need no password");
        JSONObject noAcc = StreamConfig.merge(cfg, new JSONObject("{\"clearCreds\":true}"));
        JSONObject x = new JSONObject("{\"baseUrl\":\"http://other.example\"}");
        ok(!StreamConfig.needsPassword(noAcc, StreamConfig.merge(noAcc, x), x), "S3: no saved account, no password");

        // --- connection test against fake servers ---
        HttpServer good = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        good.createContext("/player_api.php", ex -> {
            String q = ex.getRequestURI().getRawQuery();
            boolean auth = q.contains("username=USERX") && q.contains("password=PASSX");
            byte[] b = ("{\"user_info\":{\"auth\":" + (auth ? 1 : 0) + ",\"status\":\"Active\",\"exp_date\":\"1830000000\"}}").getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            try (OutputStream o = ex.getResponseBody()) { o.write(b); }
        });
        good.start();
        HttpServer plain = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);   // not Xtream: playlist check
        plain.createContext("/", ex -> {
            boolean m3u = ex.getRequestURI().getPath().equals("/live/USERX/PASSX/304369.m3u8");
            byte[] b = (m3u ? "#EXTM3U\n" : "not found").getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(m3u ? 200 : 404, b.length);
            try (OutputStream o = ex.getResponseBody()) { o.write(b); }
        });
        plain.start();
        File dir = Files.createTempDirectory("sc").toFile();
        File ch = new File(dir, "channels.json");
        Files.write(ch.toPath(), "{\"channels\":[{\"id\":\"uabcd1234\",\"name\":\"x\",\"url\":\"https://f/a.m3u8\"},{\"id\":\"304369\",\"name\":\"b\"}]}".getBytes(StandardCharsets.UTF_8));

        String g = "http://127.0.0.1:" + good.getAddress().getPort(), p = "http://127.0.0.1:" + plain.getAddress().getPort();
        JSONObject tc = StreamConfig.merge(cfg, new JSONObject().put("baseUrl", g).put("baseUrls", new JSONArray().put(p).put("http://127.0.0.1:9")).put("clearKey", true));
        long t0 = System.currentTimeMillis();
        JSONObject r = StreamConfig.test(tc, ch);
        JSONArray s = r.getJSONArray("servers");
        System.out.println("  " + s + "  " + (System.currentTimeMillis() - t0) + " ms");
        ok(s.getJSONObject(0).getBoolean("ok") && s.getJSONObject(0).getString("note").contains("2027"), "test: panel answers, expiry shown");
        ok(s.getJSONObject(1).getBoolean("ok") && s.getJSONObject(1).getString("note").contains("304369"), "test: playlist check with first numbered channel");
        ok(!s.getJSONObject(2).getBoolean("ok"), "test: closed port fails");
        ok(!r.toString().contains("USERX") && !r.toString().contains("PASSX"), "test: result has no secrets");
        ok(!r.getJSONObject("youtube").getBoolean("ok"), "test: no key reported");
        JSONObject wrong = StreamConfig.merge(tc, new JSONObject("{\"username\":\"bad\",\"password\":\"bad\"}"));
        ok(!StreamConfig.test(wrong, ch).getJSONArray("servers").getJSONObject(0).getBoolean("ok"), "test: wrong account rejected");
        good.stop(0);
        plain.stop(0);

        System.out.println(fails == 0 ? "ALL PASS" : fails + " FAILED");
        System.exit(fails);
    }
}
