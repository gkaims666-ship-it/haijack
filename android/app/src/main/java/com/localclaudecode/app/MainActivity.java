package com.localclaudecode.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.security.SecureRandom;

/**
 * Единственный экран приложения: запускает встроенный Node.js с веб-интерфейсом программы
 * (lcc --web) на 127.0.0.1 и показывает его в WebView.
 */
public class MainActivity extends Activity {
    private static final String TAG = "LCC";
    private static final int STORAGE_REQUEST = 1;
    private static final int NOTIFICATION_REQUEST = 2;
    private static final int STARTUP_TIMEOUT_MS = 60_000;

    // Node живёт дольше экрана (экран пересоздаётся, процесс — нет), поэтому состояние статическое
    private static boolean nodeStarted;
    private static int port;
    private static String token;
    private static volatile Integer nodeExitCode;

    static int serverPort() { return port; }
    static String serverToken() { return token; }

    private WebView webView;
    private TextView status;
    private boolean waitingForStorageSettings;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        webView = new WebView(this);
        webView.setVisibility(View.INVISIBLE);
        root.addView(webView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        status = new TextView(this);
        status.setText(R.string.starting);
        status.setTextSize(16);
        status.setGravity(Gravity.CENTER);
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        status.setPadding(pad, pad, pad, pad);
        root.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // Свой сервер и сессия на компьютере в локальной сети открываются внутри приложения
                if (isLocalNetworkHost(uri.getHost()) && "http".equals(uri.getScheme())) return false;
                // Внешние ссылки открываются в браузере, а не внутри приложения
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (RuntimeException e) {
                    Log.w(TAG, "Не удалось открыть ссылку " + uri, e);
                }
                return true;
            }
        });

        if (nodeStarted) {
            showWhenReady();
        } else {
            askStorageThenStart();
        }
    }

    // ---------- доступ к файлам ----------

    private boolean hasStorageAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private void askStorageThenStart() {
        final SharedPreferences prefs = getPreferences(MODE_PRIVATE);
        if (hasStorageAccess() || prefs.getBoolean("storageAsked", false)) {
            startNode();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.storage_title)
                .setMessage(R.string.storage_message)
                .setCancelable(false)
                .setPositiveButton(R.string.storage_allow, (dialog, which) -> {
                    prefs.edit().putBoolean("storageAsked", true).apply();
                    requestStorage();
                })
                .setNegativeButton(R.string.storage_skip, (dialog, which) -> {
                    prefs.edit().putBoolean("storageAsked", true).apply();
                    startNode();
                })
                .show();
    }

    private void requestStorage() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            waitingForStorageSettings = true;
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
            } catch (RuntimeException e) {
                // На части прошивок экрана для одного приложения нет — открываем общий список
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                } catch (RuntimeException e2) {
                    Log.w(TAG, "Экран доступа к файлам недоступен", e2);
                    waitingForStorageSettings = false;
                    startNode();
                }
            }
        } else {
            requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, STORAGE_REQUEST);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (waitingForStorageSettings) {
            // Пользователь вернулся из настроек — запускаемся с тем доступом, который он дал
            waitingForStorageSettings = false;
            startNode();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == STORAGE_REQUEST) startNode();
    }

    // ---------- запуск Node ----------

    private File workspaceDir() {
        File dir = null;
        if (hasStorageAccess()) {
            // Папка прежних версий остаётся рабочей, чтобы проекты не «пропали» после обновления
            File old = new File(Environment.getExternalStorageDirectory(), "LocalClaudeCode");
            dir = old.isDirectory() ? old : new File(Environment.getExternalStorageDirectory(), "haijack");
            if (!dir.isDirectory() && !dir.mkdirs()) dir = null;
        }
        if (dir == null) {
            File external = getExternalFilesDir(null);
            dir = new File(external != null ? external : getFilesDir(), "workspace");
            if (!dir.isDirectory() && !dir.mkdirs()) {
                dir = new File(getFilesDir(), "workspace");
                dir.mkdirs();
            }
        }
        return dir;
    }

    private synchronized void startNode() {
        if (nodeStarted) {
            showWhenReady();
            return;
        }
        nodeStarted = true;

        final File appDir = new File(getFilesDir(), "lcc");
        final File home = getFilesDir();
        final File workspace = workspaceDir();
        final File configDir = new File(home, ".lcc");

        byte[] random = new byte[24];
        new SecureRandom().nextBytes(random);
        StringBuilder hex = new StringBuilder();
        for (byte b : random) hex.append(String.format("%02x", b));
        token = hex.toString();
        // Только в отладочной сборке (она не публикуется): проверка в эмуляторе задаёт ключ доступа сама,
        // чтобы управлять приложением снаружи. В обычной сборке ключ всегда случайный.
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            String given = getIntent().getStringExtra("lcc_token");
            if (given != null && given.matches("[0-9a-f]{48}")) token = given;
        }

        Thread node = new Thread(null, () -> {
            try {
                // Код программы обновляется вместе с приложением, поэтому копируется при каждом запуске
                deleteRecursively(appDir);
                copyAssets(getAssets(), "lcc", appDir);
                port = freePort();

                Os.setenv("HOME", home.getAbsolutePath(), true);
                Os.setenv("LCC_HOME", configDir.getAbsolutePath(), true);
                Os.setenv("TMPDIR", getCacheDir().getAbsolutePath(), true);
                Os.setenv("LCC_WEB_TOKEN", token, true);
                Os.setenv("LCC_WEB_PORT", String.valueOf(port), true);
                Os.setenv("NO_COLOR", "1", true);

                Log.i(TAG, "starting node, workspace " + workspace);
                int code = NodeRunner.startNodeWithArguments(new String[] {
                        "node", new File(appDir, "bin/lcc.js").getAbsolutePath(), "--web", "--cwd", workspace.getAbsolutePath()
                });
                Log.e(TAG, "node exited with code " + code);
                nodeExitCode = code;
            } catch (IOException | ErrnoException | RuntimeException | UnsatisfiedLinkError e) {
                Log.e(TAG, "node failed to start", e);
                nodeExitCode = -1;
            }
        }, "node-main", 16L * 1024 * 1024); // V8 нужен стек больше стандартного для Java-потока
        node.start();
        keepAlive();
        showWhenReady();
    }

    /** Запускает службу, которая не даёт системе остановить приложение в фоне. */
    private void keepAlive() {
        try {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                // Без разрешения служба тоже работает, просто её уведомление не показывается
                requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            }
            Intent service = new Intent(this, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(service); else startService(service);
        } catch (RuntimeException e) {
            Log.w(TAG, "keep-alive service failed to start", e);
        }
    }

    /** Ждёт, пока сервер программы начнёт принимать соединения, и открывает интерфейс. */
    private void showWhenReady() {
        new Thread(() -> {
            long deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS;
            boolean ready = false;
            while (System.currentTimeMillis() < deadline && nodeExitCode == null) {
                if (port > 0) {
                    try (Socket socket = new Socket()) {
                        socket.connect(new InetSocketAddress("127.0.0.1", port), 500);
                        ready = true;
                        break;
                    } catch (IOException ignored) {
                        // сервер ещё не поднялся
                    }
                }
                try {
                    Thread.sleep(150);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            final boolean ok = ready;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                if (ok) {
                    Log.i(TAG, "server ready on port " + port);
                    webView.loadUrl("http://127.0.0.1:" + port + "/?t=" + token);
                    webView.setVisibility(View.VISIBLE);
                    status.setVisibility(View.GONE);
                } else if (nodeExitCode != null) {
                    Log.e(TAG, "startup failed: node exited");
                    status.setText(getString(R.string.node_exited, nodeExitCode));
                } else {
                    Log.e(TAG, "startup failed: timeout");
                    status.setText(getString(R.string.start_failed, new File(getFilesDir(), ".lcc/web.log").getAbsolutePath()));
                }
            });
        }, "wait-server").start();
    }

    /** Адрес этого устройства или частной сети (10.x, 172.16–31.x, 192.168.x) */
    static boolean isLocalNetworkHost(String host) {
        if (host == null) return false;
        if (host.equals("127.0.0.1") || host.equals("localhost")) return true;
        String[] p = host.split("\\.");
        if (p.length != 4) return false;
        try {
            int a = Integer.parseInt(p[0]);
            int b = Integer.parseInt(p[1]);
            Integer.parseInt(p[2]);
            Integer.parseInt(p[3]);
            return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
        } catch (NumberFormatException e) {
            return false;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))) {
            return socket.getLocalPort();
        }
    }

    private static void copyAssets(AssetManager assets, String path, File target) throws IOException {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            // Файл (или пустая папка — таких в ассетах не бывает)
            File parent = target.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                throw new IOException("Не удалось создать папку " + parent);
            }
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            }
            return;
        }
        for (String child : children) copyAssets(assets, path + "/" + child, new File(target, child));
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteRecursively(child);
        if (file.exists() && !file.delete()) Log.w(TAG, "Не удалось удалить " + file);
    }

    @Override
    public void onBackPressed() {
        // Из сессии компьютера «Назад» возвращает к программе на этом устройстве
        String url = webView.getUrl();
        String host = url == null ? null : Uri.parse(url).getHost();
        if (port > 0 && host != null && !"127.0.0.1".equals(host)) {
            webView.loadUrl("http://127.0.0.1:" + port + "/?t=" + token);
            return;
        }
        // Иначе «Назад» сворачивает приложение: работа агентов при этом продолжается
        moveTaskToBack(true);
    }
}
