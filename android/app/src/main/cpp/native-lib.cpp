// Мост между Java и встроенным Node.js (nodejs-mobile): запускает node::Start с переданными аргументами.

#include <jni.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

extern "C" JNIEXPORT jint JNICALL
Java_com_localclaudecode_app_NodeRunner_startNodeWithArguments(JNIEnv *env, jclass, jobjectArray arguments) {
    const jsize count = env->GetArrayLength(arguments);

    // libuv требует, чтобы строки argv лежали в памяти подряд, одним блоком
    std::vector<std::string> args;
    args.reserve(count);
    size_t total = 0;
    for (jsize i = 0; i < count; i++) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char *chars = env->GetStringUTFChars(item, nullptr);
        args.emplace_back(chars);
        env->ReleaseStringUTFChars(item, chars);
        env->DeleteLocalRef(item);
        total += args.back().size() + 1;
    }

    char *buffer = static_cast<char *>(calloc(total, sizeof(char)));
    std::vector<char *> argv(count);
    char *position = buffer;
    for (jsize i = 0; i < count; i++) {
        memcpy(position, args[i].c_str(), args[i].size() + 1);
        argv[i] = position;
        position += args[i].size() + 1;
    }

    // Возвращается только при завершении Node; буфер должен жить всё это время
    const int code = node::Start(count, argv.data());
    free(buffer);
    return static_cast<jint>(code);
}
