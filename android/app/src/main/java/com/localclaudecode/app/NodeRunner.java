package com.localclaudecode.app;

/** Встроенный Node.js (nodejs-mobile). Запускается один раз на процесс: node::Start нельзя вызвать повторно. */
final class NodeRunner {
    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    private NodeRunner() {}

    /** Блокирует поток до завершения Node и возвращает код выхода. */
    static native int startNodeWithArguments(String[] arguments);
}
