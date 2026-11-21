package io.github.rogentz.pocketlab;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends BridgeActivity {

    private static final String CLEAN_MOBILE_UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

    private final AtomicInteger primaryFailureStreak = new AtomicInteger(0);
    private volatile long primaryCooldownUntil = 0L;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_NO);
        super.onCreate(savedInstanceState);

        getWindow().getDecorView().setBackgroundColor(0xFFF6F6F4);
        WindowInsetsControllerCompat insetsController =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (insetsController != null) {
            insetsController.setAppearanceLightStatusBars(true);
            insetsController.setAppearanceLightNavigationBars(true);
        }

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                webView.setForceDarkAllowed(false);
            }
            String ua = webView.getSettings().getUserAgentString();
            if (ua != null && ua.contains("; wv)")) {
                webView.getSettings().setUserAgentString(
                    ua.replace("; wv)", ")").replace("Version/4.0 ", "")
                );
            }
            webView.addJavascriptInterface(new PocketLabNativeBridge(), "PocketLabNative");

            getBridge().setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request != null ? request.getUrl() : null;
                    if (uri != null) {
                        String host = uri.getHost();
                        String path = uri.getPath();
                        if ("game.pokemontcgpocket.app".equalsIgnoreCase(host)) {
                            return proxyPrimaryZhImage(uri.toString());
                        }
                        if ("localhost".equalsIgnoreCase(host) && path != null && path.startsWith("/__52poke_card/")) {
                            return fetch52PokeCard(path);
                        }
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });

            ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
                Insets bars = windowInsets.getInsets(
                    WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout()
                        | WindowInsetsCompat.Type.ime()
                );
                ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
                if (lp != null) {
                    lp.leftMargin = bars.left;
                    lp.topMargin = bars.top;
                    lp.rightMargin = bars.right;
                    lp.bottomMargin = bars.bottom;
                    view.setLayoutParams(lp);
                }
                return WindowInsetsCompat.CONSUMED;
            });
            ViewCompat.requestApplyInsets(webView);
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() != null ? getBridge().getWebView() : null;
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }

    private WebResourceResponse proxyPrimaryZhImage(String url) {
        long now = System.currentTimeMillis();
        if (now < primaryCooldownUntil) {
            return notFoundResponse();
        }
        HttpResult res = fetchUrlBytes(url, null, "image/webp,image/*,*/*;q=0.8");
        if (res.status == 200 && res.bytes != null && res.bytes.length > 0) {
            primaryFailureStreak.set(0);
            return okImageResponse("image/webp", res.bytes);
        }
        // Only trip circuit breaker on network errors or upstream 403/5xx, not isolated missing card 404s
        if (res.status != 404 && primaryFailureStreak.incrementAndGet() >= 4) {
            primaryCooldownUntil = System.currentTimeMillis() + 60_000L;
        }
        return notFoundResponse();
    }

    private WebResourceResponse fetch52PokeCard(String path) {
        String rel = path.substring("/__52poke_card/".length());
        if (rel.endsWith(".png")) {
            rel = rel.substring(0, rel.length() - 4);
        }
        String[] parts = rel.split("/", 2);
        if (parts.length != 2 || parts[0].isEmpty() || parts[1].isEmpty()) {
            return notFoundResponse();
        }
        String setCode = parts[0].replaceAll("[^A-Za-z0-9\\-]", "");
        String numStr = parts[1].replaceAll("[^A-Za-z0-9]", "");
        boolean hyphenPreferred = !setCode.contains("-") && !setCode.isEmpty() && !Character.isLowerCase(setCode.charAt(setCode.length() - 1));
        String[] candidates = hyphenPreferred
            ? new String[]{ setCode + "-" + numStr + ".png", setCode + numStr + ".png" }
            : new String[]{ setCode + numStr + ".png", setCode + "-" + numStr + ".png" };

        for (String fname : candidates) {
            String url = build52PokeMediaUrl(fname);
            if (url == null) continue;
            HttpResult res = fetchUrlBytes(url, "https://wiki.52poke.com/", "image/png,image/*,*/*;q=0.8");
            if (res.status == 200 && res.bytes != null && res.bytes.length > 0) {
                return okImageResponse("image/png", res.bytes);
            }
        }
        return notFoundResponse();
    }

    private static String build52PokeMediaUrl(String filename) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(filename.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(32);
            for (byte b : digest) {
                hex.append(String.format(Locale.US, "%02x", b & 0xff));
            }
            String h = hex.toString();
            return "https://media.52poke.com/wiki/" + h.charAt(0) + "/" + h.substring(0, 2) + "/" + Uri.encode(filename);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static HttpResult fetchUrlBytes(String targetUrl, String referer, String accept) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(targetUrl).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(7000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", CLEAN_MOBILE_UA);
            conn.setRequestProperty("Accept", accept);
            conn.setRequestProperty("Accept-Language", "zh-TW,zh;q=0.9,en;q=0.7");
            if (referer != null) {
                conn.setRequestProperty("Referer", referer);
            }
            int code = conn.getResponseCode();
            if (code != 200) {
                return new HttpResult(code, null);
            }
            try (InputStream is = conn.getInputStream(); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) != -1) {
                    bos.write(buf, 0, n);
                }
                return new HttpResult(200, bos.toByteArray());
            }
        } catch (Exception ignored) {
            return new HttpResult(0, null);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static WebResourceResponse okImageResponse(String mimeType, byte[] bytes) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "public, max-age=86400");
        return new WebResourceResponse(mimeType, null, 200, "OK", headers, new ByteArrayInputStream(bytes));
    }

    private static WebResourceResponse notFoundResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
    }

    private static final class HttpResult {
        final int status;
        final byte[] bytes;
        HttpResult(int status, byte[] bytes) {
            this.status = status;
            this.bytes = bytes;
        }
    }

    private final class PocketLabNativeBridge {
        @JavascriptInterface
        public boolean exportTextFile(String filename, String content, String mimeType) {
            try {
                File exportDir = new File(getCacheDir(), "exports");
                if (!exportDir.exists() && !exportDir.mkdirs()) {
                    return false;
                }
                String safeName = (filename == null ? "" : filename).replaceAll("[^a-zA-Z0-9._\\-\\u4e00-\\u9fff]", "_");
                if (safeName.isEmpty()) {
                    safeName = "pocket-lab-export.json";
                }
                File outFile = new File(exportDir, safeName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
                }
                Uri contentUri = FileProvider.getUriForFile(
                    MainActivity.this,
                    getPackageName() + ".fileprovider",
                    outFile
                );
                String resolvedMime = (mimeType == null || mimeType.isEmpty()) ? "application/json" : mimeType;
                Intent shareIntent = new Intent(Intent.ACTION_SEND);
                shareIntent.setType(resolvedMime);
                shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
                shareIntent.putExtra(Intent.EXTRA_SUBJECT, safeName);
                shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

                runOnUiThread(() -> startActivity(Intent.createChooser(shareIntent, "匯出牌組檔案")));
                return true;
            } catch (Exception ignored) {
                return false;
            }
        }
    }
}
