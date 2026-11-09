cmake_minimum_required(VERSION 3.18.1)
project(lcc-native CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libnode (nodejs-mobile) скачивается перед сборкой скриптом android/fetch-node.sh
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/libnode)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES
    IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED src/main/cpp/native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)
target_link_libraries(native-lib node log)
