package com.localclaudecode.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Не даёт Android остановить приложение, пока оно свёрнуто: без этого длинные и непрерывные
 * задачи обрывались бы через несколько минут. Пока агенты работают, служба дополнительно
 * удерживает процессор от сна; в простое блокировка отпускается, чтобы не тратить батарею.
 */
public class KeepAliveService extends Service {
    private static final String TAG = "LCC";
    private static final String CHANNEL = "lcc-work";
    private static final int NOTIFICATION_ID = 1;
    private static final int POLL_MS = 15_000;

    private PowerManager.WakeLock wakeLock;
    private Thread watcher;
    private volatile boolean stopped;

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        startForeground(NOTIFICATION_ID, buildNotification(false));

        PowerManager power = getSystemService(PowerManager.class);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lcc:agents");
        wakeLock.setReferenceCounted(false);

        watcher = new Thread(this::watch, "lcc-keepalive");
        watcher.setDaemon(true);
        watcher.start();
        Log.i(TAG, "keep-alive service started");
    }

    private Notification buildNotification(boolean busy) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(busy ? R.string.notification_busy : R.string.notification_idle))
                .setContentIntent(tap)
                .setOngoing(true)
                .build();
    }

    /** Раз в несколько секунд спрашивает у программы, идёт ли задача, и по ответу держит или отпускает процессор. */
    private void watch() {
        boolean lastBusy = false;
        while (!stopped) {
            boolean busy = isBusy();
            try {
                if (busy && !wakeLock.isHeld()) wakeLock.acquire(60 * 60 * 1000L); // с запасом: продлевается, пока задача идёт
                if (!busy && wakeLock.isHeld()) wakeLock.release();
            } catch (RuntimeException e) {
                Log.w(TAG, "wake lock", e);
            }
            if (busy != lastBusy) {
                lastBusy = busy;
                getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification(busy));
            }
            try {
                Thread.sleep(POLL_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    private static boolean isBusy() {
        int port = MainActivity.serverPort();
        String token = MainActivity.serverToken();
        if (port <= 0 || token == null) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL("http://127.0.0.1:" + port + "/api/state?t=" + token).openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(4000);
            if (connection.getResponseCode() != 200) return false;
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                String body = new String(out.toByteArray(), StandardCharsets.UTF_8);
                // Задача агентов или загрузка модели, которая ещё не закончилась
                return body.contains("\"busy\":true") || body.contains("\"done\":false");
            }
        } catch (IOException e) {
            return false; // программа ещё запускается или перезапускается
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY; // без экрана приложения служба ничего полезного не делает
    }

    @Override
    public void onDestroy() {
        stopped = true;
        if (watcher != null) watcher.interrupt();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
